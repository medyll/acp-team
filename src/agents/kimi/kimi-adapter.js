import { KimiAcpClient } from "./kimi-acp-client.js";
import { MODES, toolSummary } from "../agent.js";
import { createSessionQueue } from "../session-queue.js";

/**
 * Kimi Code CLI, driven over ACP (`kimi acp`, JSON-RPC on stdio).
 *
 * One long-lived kimi process backs every session; sessions are real ACP
 * sessions, so conversation state lives inside the agent.
 */
export function createKimiAdapter({ defaultModel, defaultMode, permissionPolicy, log, client: suppliedClient } = {}) {
  const client = suppliedClient ?? new KimiAcpClient({ permissionPolicy, onLog: log });
  /** cwd -> sessionId */
  const sessions = new Map();
  const queue = createSessionQueue();
  /** Model list is only advertised in a session/new response, so cache the first one we see. */
  let knownModels = null;

  async function resolveSession({ sessionId, cwd, model, mode, thinking, newSession }) {
    if (sessionId) return sessionId;
    if (!newSession && sessions.has(cwd)) return sessions.get(cwd);
    const res = await client.newSession({
      cwd,
      model: model || defaultModel,
      mode: mode || defaultMode,
      thinking
    });
    knownModels ??= res.configOptions?.find((o) => o.id === "model")?.options?.map((o) => o.value) ?? null;
    sessions.set(cwd, res.sessionId);
    log(`kimi: new session ${res.sessionId} (cwd=${cwd})`);
    return res.sessionId;
  }

  return {
    id: "kimi",
    description: "Kimi Code CLI over ACP. Strong on long-context reasoning; runs its own file and shell tools.",
    modes: MODES,

    async status() {
      const init = await client.start();
      if (!knownModels) {
        const probe = await client.newSession({ cwd: process.cwd() });
        knownModels = probe.configOptions?.find((o) => o.id === "model")?.options?.map((o) => o.value) ?? [];
      }
      return {
        agent: init.agentInfo,
        transport: `ACP v${init.protocolVersion} over stdio`,
        models: knownModels,
        defaults: { model: defaultModel ?? "(agent default)", mode: defaultMode, permission: permissionPolicy },
        sessions: [...sessions.entries()].map(([cwd, id]) => ({ cwd, sessionId: id }))
      };
    },

    async ask({ prompt, cwd, sessionId, newSession, model, mode, thinking, options, signal, onEvent }) {
      // A cwd identifies an implicit session; an explicit id takes precedence.
      // Queue the whole turn so configuration and prompt messages cannot interleave.
      return queue.run(sessionId ?? sessions.get(cwd) ?? cwd, async () => {
        throwIfAborted(signal);
        onEvent?.({ type: "turn.started" });
        await client.start();
        throwIfAborted(signal);
        const before = sessions.get(cwd);
        const sid = await resolveSession({ sessionId, cwd, model, mode, thinking, newSession });
        onEvent?.({ type: "session.started", sessionId: sid });
        const abortTurn = () => {
          try {
            client.cancel(sid);
          } catch (error) {
            log?.(`kimi: cancel failed for ${sid}: ${error.message}`);
          }
        };
        signal?.addEventListener("abort", abortTurn, { once: true });
        if (signal?.aborted) {
          abortTurn();
          throwIfAborted(signal);
        }
        // A session created just now already carries these; one being continued —
        // whether named explicitly or reused for this cwd — has to be reconfigured.
        const reused = sid === sessionId || sid === before;
        if (reused && model) await client.setConfigOption(sid, "model", model);
        if (reused && thinking) await client.setConfigOption(sid, "thinking", thinking);
        if (reused && mode) await client.setMode(sid, mode);
        // Free-form config options, applied after the model so they are validated
        // against the option set that model actually offers.
        for (const [configId, value] of Object.entries(options ?? {})) {
          await client.setConfigOption(sid, configId, value);
        }
        try {
          const res = await client.prompt(sid, prompt, {
            onUpdate: (update) => onEvent?.(normalizeKimiUpdate(update))
          });
          throwIfAborted(signal);
          return {
            sessionId: sid,
            text: res.text,
            thoughts: res.thoughts,
            toolCalls: res.toolCalls.map((t) => toolSummary(t.title ?? t.kind, t.status)),
            stopReason: res.stopReason
          };
        } finally {
          signal?.removeEventListener("abort", abortTurn);
        }
      });
    },

    cancel(sessionId) {
      client.cancel(sessionId);
    },

    stop() {
      client.stop();
    }
  };
}

function normalizeKimiUpdate(update) {
  const types = {
    agent_message_chunk: "message.delta",
    agent_thought_chunk: "thought.updated",
    tool_call: "tool.started",
    tool_call_update: "tool.updated"
  };
  const event = {
    type: types[update?.sessionUpdate] ?? "agent.update",
    title: update?.title ?? update?.kind,
    toolCallId: update?.toolCallId,
    status: update?.status
  };
  // Stream assistant text, but never expose the private reasoning payload.
  if (update?.sessionUpdate === "agent_message_chunk") event.text = visibleText(update.content);
  return event;
}

function visibleText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(visibleText).join("");
  return content.type === "text" ? content.text ?? "" : "";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason?.message ?? "Agent turn cancelled");
  error.name = "AbortError";
  throw error;
}
