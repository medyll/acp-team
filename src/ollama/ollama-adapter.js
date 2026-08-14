import { randomUUID } from "node:crypto";
import { createOllamaClient } from "./ollama-client.js";

export function createOllamaAdapter({ defaultModel = process.env.OLLAMA_BRIDGE_MODEL, client = createOllamaClient(), log = () => {} } = {}) {
  const sessions = new Map();
  const byCwd = new Map();
  const live = new Map();

  async function resolveModel(requested) {
    if (requested || defaultModel) return requested || defaultModel;
    const response = await client.list();
    const available = (response.models ?? []).map((item) => item.model ?? item.name).filter(Boolean);
    if (!available.length) throw new Error("Ollama has no local model. Pull one with `ollama_pull` or pass a cloud model with `model`.");
    throw new Error(`Choose an Ollama model with \`model\` or OLLAMA_BRIDGE_MODEL. Available: ${available.slice(0, 10).join(", ")}`);
  }

  return {
    id: "ollama",
    description: "Ollama API, implemented natively. Local or Ollama Cloud models; conversational inference without file or shell access.",
    modes: ["plan", "default"],

    async status() {
      try {
        const [version, listed, running] = await Promise.all([
          client.version().catch(() => ({ version: "unknown" })),
          client.list(),
          client.ps().catch(() => ({ models: [] }))
        ]);
        return {
          agent: { name: "Ollama", version: version.version ?? "unknown" },
          transport: `Ollama HTTP API (${client.host})`,
          models: (listed.models ?? []).map((item) => item.model ?? item.name),
          running: (running.models ?? []).map((item) => item.model ?? item.name),
          defaults: { model: defaultModel ?? "explicit model required", mode: "plan" },
          sessions: [...sessions.keys()].map((sessionId) => ({ sessionId }))
        };
      } catch (error) {
        return {
          agent: { name: "Ollama", version: "unavailable" },
          transport: `Ollama HTTP API (${client.host})`,
          models: [], defaults: { model: defaultModel ?? "not configured", mode: "plan" }, sessions: [],
          error: error.message
        };
      }
    },

    async ask({ prompt, cwd, sessionId, newSession, model, options, signal, onEvent }) {
      const previousId = sessionId ?? (!newSession ? byCwd.get(cwd) : null);
      const id = previousId || `ollama_${randomUUID()}`;
      const state = sessions.get(id) ?? { model: await resolveModel(model), messages: [] };
      if (model && state.messages.length && model !== state.model) throw new Error("Cannot change the Ollama model inside an existing session; start a new session.");
      state.model = model || state.model;
      state.messages.push({ role: "user", content: prompt });
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      live.set(id, controller);
      onEvent?.({ type: "session.started", sessionId: id });
      onEvent?.({ type: "turn.started" });
      try {
        const response = await client.chat({ model: state.model, messages: state.messages, think: options?.think, options: options?.runtime, signal: controller.signal });
        const text = response.message?.content ?? "";
        state.messages.push({ role: "assistant", content: text });
        sessions.set(id, state);
        byCwd.set(cwd, id);
        onEvent?.({ type: "message.updated", text });
        onEvent?.({ type: "agent.turn_completed", usage: { inputTokens: response.prompt_eval_count, outputTokens: response.eval_count } });
        return {
          sessionId: id,
          text,
          thoughts: response.message?.thinking ?? "",
          toolCalls: [],
          stopReason: response.done_reason ?? "end_turn",
          usage: { inputTokens: response.prompt_eval_count ?? null, outputTokens: response.eval_count ?? null, totalTokens: addNullable(response.prompt_eval_count, response.eval_count) },
          cost: { amount: null, currency: null, source: "unavailable" }
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        live.delete(id);
      }
    },

    cancel(sessionId) {
      const controller = live.get(sessionId);
      if (!controller) throw new Error(`No Ollama turn is currently running for session ${sessionId}`);
      controller.abort();
      log(`ollama: cancelled ${sessionId}`);
    },

    stop() {
      for (const controller of live.values()) controller.abort();
      live.clear();
    },

    client
  };
}

function addNullable(left, right) {
  return typeof left === "number" || typeof right === "number" ? (left ?? 0) + (right ?? 0) : null;
}
