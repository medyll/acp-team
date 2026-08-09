import { spawn } from "node:child_process";
import readline from "node:readline";
import { MODES, toolSummary } from "../agent.js";
import { createSessionQueue } from "../session-queue.js";

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
export function createCodexAdapter({ defaultModel, defaultMode, log }) {
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

  function runExec({ prompt, cwd, threadId, model, mode, options }) {
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
      const proc = spawn(CODEX_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      live.set(proc, { cwd, threadId });
      // `codex exec` reads extra prompt material from stdin; close it or it waits.
      proc.stdin.end();

      const out = { sessionId: threadId ?? null, text: "", thoughts: "", toolCalls: [], stopReason: "end_turn" };
      const errors = [];
      let stderr = "";

      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return; // non-JSON banner lines
        }
        switch (ev.type) {
          case "thread.started":
            out.sessionId = ev.thread_id;
            live.get(proc).threadId = ev.thread_id;
            break;
          case "item.completed":
            absorbItem(out, ev.item, errors);
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
        live.delete(proc);
        fn(arg);
      };

      proc.on("error", (e) =>
        settle(
          reject,
          e.code === "ENOENT"
            ? new Error(
                `Codex CLI not found (tried "${CODEX_BIN}"). Install it and run \`codex login\`, or set CODEX_BIN to its path.`
              )
            : e
        )
      );
      proc.on("close", (code) => {
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
        const p = spawn(CODEX_BIN, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
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

    async ask({ prompt, cwd, sessionId, newSession, model, mode, options }) {
      return queue.run(sessionId ?? sessions.get(cwd) ?? cwd, async () => {
        const threadId = sessionId ?? (newSession ? null : sessions.get(cwd) ?? null);
        const res = await runExec({ prompt, cwd, threadId, model, mode, options });
        if (res.sessionId) {
          sessions.set(cwd, res.sessionId);
          if (!threadId) log(`codex: new thread ${res.sessionId} (cwd=${cwd})`);
        }
        return res;
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

function absorbItem(out, item, errors) {
  if (!item) return;
  switch (item.type) {
    case "agent_message":
      out.text += (out.text ? "\n" : "") + (item.text ?? "");
      break;
    case "reasoning":
      out.thoughts += (out.thoughts ? "\n" : "") + (item.text ?? item.summary ?? "");
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
