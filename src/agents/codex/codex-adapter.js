import { spawn } from "node:child_process";
import readline from "node:readline";
import { MODES, toolSummary } from "../agent.js";
import { createSessionQueue } from "../session-queue.js";
import { appendLimited, deadlineSignal } from "../../resilience.js";

const CODEX_BIN = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.exe" : "codex");
const SKIP_GIT_CHECK = process.env.CODEX_BRIDGE_SKIP_GIT_CHECK !== "false";

/**
 * Codex CLI does not speak ACP (no `codex acp` subcommand as of 0.145.0).
 * It is driven instead through `codex exec --json`, which streams JSONL events
 * and exits at the end of the turn. Conversation state is resumed by thread id
 * via `codex exec resume <thread_id>`.
 *
 * Mode mapping — `exec` is non-interactive, so there is nobody to approve a
 * command. Modes select a sandbox policy instead of an approval policy:
 *   plan            -> --sandbox read-only
 *   default | auto  -> --sandbox workspace-write
 *   yolo            -> --dangerously-bypass-approvals-and-sandbox
 */
export function createCodexAdapter({ defaultModel, defaultMode, log, timeoutMs = 10 * 60_000, maxOutputBytes = 4 * 1024 * 1024, spawnImpl = spawn, bin = CODEX_BIN }) {
  /** cwd -> thread_id */
  const sessions = new Map();
  const queue = createSessionQueue();
  /** Turns currently running: ChildProcess -> { cwd, threadId }. Needed because a
   *  turn is a process, so cancelling and shutting down mean killing it. */
  const live = new Map();

  // `codex exec resume` accepts a much smaller flag set than `codex exec`: no
  // --sandbox, no --cd, no --color. Everything below therefore uses only flags
  // both accept — sandbox via a -c config override, cwd via the spawn option.
  function sandboxArgs(mode) {
    switch (mode || defaultMode) {
      case "plan":
        return ["-c", 'sandbox_mode="read-only"'];
      case "yolo":
        return ["--dangerously-bypass-approvals-and-sandbox"];
      default:
        return ["-c", 'sandbox_mode="workspace-write"'];
    }
  }

  function runExec({ prompt, cwd, threadId, model, mode, options, signal, onEvent }) {
    throwIfAborted(signal);
    const flags = ["--json", ...sandboxArgs(mode)];
    if (SKIP_GIT_CHECK) flags.push("--skip-git-repo-check");
    if (model || defaultModel) flags.push("--model", model || defaultModel);
    // Free-form config overrides, same syntax as `codex -c key=value`. Values are
    // TOML, so strings need their quotes; numbers and booleans go through bare.
    for (const [key, value] of Object.entries(options ?? {})) {
      flags.push("-c", `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`);
    }

    const args = threadId
      ? ["exec", "resume", ...flags, threadId, prompt]
      : ["exec", ...flags, prompt];

    return new Promise((resolve, reject) => {
      const proc = spawnImpl(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      live.set(proc, { cwd, threadId });
      const abortTurn = () => proc.kill();
      signal?.addEventListener("abort", abortTurn, { once: true });
      // `codex exec` reads extra prompt material from stdin; close it or it waits.
      proc.stdin.end();

      const out = { sessionId: threadId ?? null, text: "", thoughts: "", toolCalls: [], stopReason: "end_turn" };
      const errors = [];
      let stderr = "";

      proc.stderr.on("data", (d) => {
        try {
          stderr = appendLimited(stderr, d, maxOutputBytes, "Codex stderr");
        } catch (error) {
          errors.push(error.message);
          proc.kill();
        }
      });

      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return; // non-JSON banner lines
        }
        const observable = normalizeCodexEvent(ev);
        if (observable) onEvent?.(observable);
        switch (ev.type) {
          case "thread.started":
            out.sessionId = ev.thread_id;
            live.get(proc).threadId = ev.thread_id;
            onEvent?.({ type: "session.started", sessionId: ev.thread_id });
            break;
          case "item.completed":
            try {
              absorbItem(out, ev.item, errors, maxOutputBytes);
            } catch (error) {
              errors.push(error.message);
              proc.kill();
            }
            break;
          case "turn.completed":
            out.usage = ev.usage;
            break;
          case "turn.failed":
            out.stopReason = "error";
            errors.push(ev.error?.message ?? "turn failed");
            break;
          default:
            break;
        }
      });

      // A failed spawn emits both `error` and `close`; the spawn error is the
      // useful one, so it wins and the close handler is neutered.
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abortTurn);
        live.delete(proc);
        fn(arg);
      };

      proc.on("error", (e) =>
        settle(
          reject,
          e.code === "ENOENT"
            ? new Error(
                `Codex CLI not found (tried "${bin}"). Install it and run \`codex login\`, or set CODEX_BIN to its path.`
              )
            : e
        )
      );
      proc.on("close", (code) => {
        if (signal?.aborted) {
          settle(reject, abortError(signal));
          return;
        }
        if (code !== 0) {
          const detail = errors.join("; ") || stderr.trim() || "no output";
          const partial = out.text ? ` (partial output: ${out.text.trim().slice(0, 200)})` : "";
          settle(reject, new Error(`codex exec exited ${code}: ${detail}${partial}`));
          return;
        }
        if (errors.length) log(`codex: ${errors.join("; ")}`);
        settle(resolve, out);
      });
    });
  }

  return {
    id: "codex",
    description: "OpenAI Codex CLI via `codex exec`. Sandboxed shell and file edits; strong on focused code changes.",
    modes: MODES,

    async status() {
      const version = await new Promise((resolve) => {
        const p = spawnImpl(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let v = "";
        p.stdout.on("data", (d) => (v += d.toString()));
        p.on("close", () => resolve(v.trim() || "unknown"));
        p.on("error", () => resolve("not installed"));
      });
      return {
        agent: { name: "Codex CLI", version },
        transport: "`codex exec --json` (JSONL events, one process per turn)",
        models: ["(whatever your ~/.codex/config.toml allows; pass `model` to override)"],
        defaults: { model: defaultModel ?? "(codex default)", mode: defaultMode, skipGitRepoCheck: SKIP_GIT_CHECK },
        sessions: [...sessions.entries()].map(([cwd, id]) => ({ cwd, sessionId: id }))
      };
    },

    async ask({ prompt, cwd, sessionId, newSession, model, mode, options, signal, onEvent }) {
      return queue.run(sessionId ?? sessions.get(cwd) ?? cwd, async () => {
        const deadline = deadlineSignal(signal, timeoutMs, "Codex turn");
        try {
          throwIfAborted(deadline.signal);
          onEvent?.({ type: "turn.started" });
          const threadId = sessionId ?? (newSession ? null : sessions.get(cwd) ?? null);
          if (threadId) onEvent?.({ type: "session.started", sessionId: threadId });
          const res = await runExec({ prompt, cwd, threadId, model, mode, options, signal: deadline.signal, onEvent });
          if (res.sessionId) {
            sessions.set(cwd, res.sessionId);
            if (!threadId) log(`codex: new thread ${res.sessionId} (cwd=${cwd})`);
          }
          return res;
        } finally {
          deadline.cleanup();
        }
      });
    },

    cancel(sessionId) {
      const hit = [...live.entries()].find(([, info]) => info.threadId === sessionId);
      if (!hit) {
        throw new Error(
          `No codex turn is currently running for session ${sessionId}. Each turn is a separate process; once it ends there is nothing to cancel.`
        );
      }
      hit[0].kill();
      log(`codex: killed running turn for ${sessionId}`);
    },

    stop() {
      for (const proc of live.keys()) proc.kill();
      live.clear();
    }
  };
}

export function absorbItem(out, item, errors, maxOutputBytes) {
  if (!item) return;
  switch (item.type) {
    case "agent_message":
      out.text = appendLimited(out.text, (out.text ? "\n" : "") + (item.text ?? ""), maxOutputBytes, "Codex message");
      break;
    case "reasoning":
      out.thoughts = appendLimited(out.thoughts, (out.thoughts ? "\n" : "") + (item.text ?? item.summary ?? ""), maxOutputBytes, "Codex thoughts");
      break;
    case "command_execution":
      out.toolCalls.push(toolSummary(`Running: ${item.command}`, item.status ?? (item.exit_code === 0 ? "completed" : "failed")));
      break;
    case "file_change":
      out.toolCalls.push(toolSummary(`Edit: ${(item.changes ?? []).map((c) => c.path).join(", ")}`, item.status ?? "completed"));
      break;
    case "mcp_tool_call":
      out.toolCalls.push(toolSummary(`MCP: ${item.server}/${item.tool}`, item.status ?? "completed"));
      break;
    case "web_search":
      out.toolCalls.push(toolSummary(`Web search: ${item.query}`, "completed"));
      break;
    case "todo_list":
      out.toolCalls.push(toolSummary(`Plan: ${(item.items ?? []).length} steps`, "completed"));
      break;
    case "error":
      errors.push(item.message ?? "unknown error");
      break;
    default:
      break;
  }
}

export function normalizeCodexEvent(event) {
  if (event.type === "thread.started") return { type: "agent.started" };
  if (event.type === "turn.started") return { type: "agent.turn_started" };
  if (event.type === "turn.completed") return { type: "agent.turn_completed", usage: event.usage };
  if (event.type === "turn.failed") return { type: "agent.turn_failed", error: event.error?.message };

  const item = event.item;
  if (!item) return null;
  switch (item.type) {
    case "agent_message":
      return { type: "message.updated", text: item.text ?? "" };
    case "reasoning":
      return { type: "thought.updated" };
    case "command_execution":
      return { type: "tool.updated", title: `Command: ${item.command}`, status: item.status };
    case "file_change":
      return {
        type: "tool.updated",
        title: `Files: ${(item.changes ?? []).map((change) => change.path).join(", ")}`,
        status: item.status
      };
    case "mcp_tool_call":
      return { type: "tool.updated", title: `MCP: ${item.server}/${item.tool}`, status: item.status };
    case "web_search":
      return { type: "tool.updated", title: `Web search: ${item.query}`, status: item.status };
    case "todo_list":
      return { type: "plan.updated", items: item.items ?? [] };
    case "error":
      return { type: "agent.error", error: item.message ?? "unknown error" };
    default:
      return { type: `agent.${event.type}`, itemType: item.type, status: item.status };
  }
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message ?? "Agent turn cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}
