import { assertSupportedMode, MODES, toolSummary } from "../agent.js";
import { createSessionQueue } from "../session-queue.js";

/**
 * Uniform adapter for ACP clients. Each cwd gets its own long-lived process,
 * so CLI disk discovery and conversation state stay anchored to that project.
 */
export function createAcpAdapter({
  id,
  description,
  client,
  createClient,
  defaultCwd = process.cwd(),
  clientIdleTimeoutMs = 10 * 60_000,
  defaultModel,
  defaultMode,
  permissionPolicy,
  mapMode = (mode) => mode,
  log
} = {}) {
  if (!id || (!client && !createClient)) throw new Error("ACP adapter requires id and a client or createClient");
  /** cwd -> sessionId */
  const sessions = new Map();
  /** cwd -> ACP client */
  const clients = new Map();
  /** sessionId -> ACP client */
  const sessionClients = new Map();
  /** sessionId -> cwd owning that client's process */
  const sessionCwds = new Map();
  /** cwd -> number of turns currently using the client */
  const activeClients = new Map();
  /** cwd -> idle eviction timer. Injected singleton clients are never evicted. */
  const idleTimers = new Map();
  const queue = createSessionQueue();
  /** Model list is only advertised in a session/new response, so cache the first one we see. */
  let knownModels = null;

  function clientFor(cwd) {
    if (client) return client;
    let cwdClient = clients.get(cwd);
    if (!cwdClient) {
      cwdClient = createClient(cwd);
      clients.set(cwd, cwdClient);
    }
    clearIdleTimer(cwd);
    return cwdClient;
  }

  function clearIdleTimer(cwd) {
    const timer = idleTimers.get(cwd);
    if (timer) clearTimeout(timer);
    idleTimers.delete(cwd);
  }

  function evictClient(cwd) {
    if (client || (activeClients.get(cwd) ?? 0) > 0) return;
    const cwdClient = clients.get(cwd);
    if (!cwdClient) return;
    cwdClient.stop();
    clients.delete(cwd);
    idleTimers.delete(cwd);
    activeClients.delete(cwd);
    sessions.delete(cwd);
    for (const [sessionId, owner] of sessionClients) {
      if (owner === cwdClient) {
        sessionClients.delete(sessionId);
        sessionCwds.delete(sessionId);
      }
    }
  }

  function scheduleIdleEviction(cwd) {
    if (client || !Number.isFinite(clientIdleTimeoutMs) || clientIdleTimeoutMs <= 0) return;
    clearIdleTimer(cwd);
    const timer = setTimeout(() => evictClient(cwd), clientIdleTimeoutMs);
    timer.unref?.();
    idleTimers.set(cwd, timer);
  }

  function acquireClient(cwd, preferredClient) {
    const cwdClient = preferredClient ?? clientFor(cwd);
    clearIdleTimer(cwd);
    activeClients.set(cwd, (activeClients.get(cwd) ?? 0) + 1);
    return cwdClient;
  }

  function releaseClient(cwd) {
    const active = Math.max(0, (activeClients.get(cwd) ?? 1) - 1);
    activeClients.set(cwd, active);
    if (active === 0) scheduleIdleEviction(cwd);
  }

  async function resolveSession({ sessionId, cwd, model, mode, thinking, newSession, cwdClient }) {
    if (sessionId) {
      const owner = sessionClients.get(sessionId) ?? cwdClient;
      sessionClients.set(sessionId, owner);
      sessionCwds.set(sessionId, sessionCwds.get(sessionId) ?? cwd);
      return { sessionId, client: owner };
    }
    if (!newSession && sessions.has(cwd)) {
      const existingSessionId = sessions.get(cwd);
      return { sessionId: existingSessionId, client: sessionClients.get(existingSessionId) ?? cwdClient };
    }
    const selectedMode = assertSupportedMode(mode || defaultMode);
    const res = await cwdClient.newSession({
      cwd,
      model: model || defaultModel,
      mode: mapMode(selectedMode),
      thinking
    });
    knownModels ??= res.configOptions?.find((o) => o.id === "model")?.options?.map((o) => o.value) ?? null;
    sessions.set(cwd, res.sessionId);
    sessionClients.set(res.sessionId, cwdClient);
    sessionCwds.set(res.sessionId, cwd);
    log?.(`${id}: new session ${res.sessionId} (cwd=${cwd})`);
    return { sessionId: res.sessionId, client: cwdClient };
  }

  return {
    id,
    description,
    modes: MODES,

    async status() {
      const cwd = clients.keys().next().value ?? defaultCwd;
      const statusClient = acquireClient(cwd);
      try {
        const init = await statusClient.start();
        if (!knownModels) {
          const probe = await statusClient.newSession({ cwd });
          knownModels = probe.configOptions?.find((o) => o.id === "model")?.options?.map((o) => o.value) ?? [];
        }
        return {
          agent: init.agentInfo,
          transport: `ACP v${init.protocolVersion} over stdio`,
          models: knownModels,
          defaults: { model: defaultModel ?? "(agent default)", mode: defaultMode, permission: permissionPolicy },
          sessions: [...sessions.entries()].map(([cwd, id]) => ({ cwd, sessionId: id }))
        };
      } finally {
        releaseClient(cwd);
      }
    },

    async ask({ prompt, cwd, sessionId, newSession, model, mode, thinking, options, signal, onEvent }) {
      assertSupportedMode(mode);
      // A cwd identifies an implicit session; an explicit id takes precedence.
      // Queue the whole turn so configuration and prompt messages cannot interleave.
      return queue.run(sessionId ?? sessions.get(cwd) ?? cwd, async () => {
        throwIfAborted(signal);
        onEvent?.({ type: "turn.started" });
        const clientCwd = sessionId ? sessionCwds.get(sessionId) ?? cwd : cwd;
        const initialClient = sessionId ? sessionClients.get(sessionId) : null;
        const cwdClient = acquireClient(clientCwd, initialClient);
        let abortTurn;
        try {
          await cwdClient.start();
          throwIfAborted(signal);
          const before = sessions.get(cwd);
          const resolved = await resolveSession({ sessionId, cwd, model, mode, thinking, newSession, cwdClient });
          const sid = resolved.sessionId;
          const turnClient = resolved.client;
          onEvent?.({ type: "session.started", sessionId: sid });
          abortTurn = () => {
            try {
              turnClient.cancel(sid);
            } catch (error) {
              log?.(`${id}: cancel failed for ${sid}: ${error.message}`);
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
          if (reused && model) await turnClient.setConfigOption(sid, "model", model);
          if (reused && thinking) await turnClient.setConfigOption(sid, "thinking", thinking);
          if (reused && mode) await turnClient.setMode(sid, mapMode(mode));
          // Free-form config options, applied after the model so they are validated
          // against the option set that model actually offers.
          for (const [configId, value] of Object.entries(options ?? {})) {
            await turnClient.setConfigOption(sid, configId, value);
          }
          const res = await turnClient.prompt(sid, prompt, {
            onUpdate: (update) => onEvent?.(normalizeAcpUpdate(update))
          });
          throwIfAborted(signal);
          return {
            sessionId: sid,
            text: res.text,
            thoughts: res.thoughts,
            toolCalls: res.toolCalls.map((t) => toolSummary(t.title ?? t.kind, t.status)),
            stopReason: res.stopReason,
            usage: res.usage
          };
        } finally {
          if (abortTurn) signal?.removeEventListener("abort", abortTurn);
          releaseClient(clientCwd);
        }
      });
    },

    cancel(sessionId) {
      const owner = sessionClients.get(sessionId) ?? client;
      if (!owner) throw new Error(`Unknown ${id} session: ${sessionId}`);
      owner.cancel(sessionId);
    },

    stop() {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      const allClients = new Set(clients.values());
      if (client) allClients.add(client);
      for (const cwdClient of allClients) cwdClient.stop();
      idleTimers.clear();
      activeClients.clear();
      clients.clear();
      sessions.clear();
      sessionClients.clear();
      sessionCwds.clear();
    }
  };
}

function normalizeAcpUpdate(update) {
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
  if (update?.sessionUpdate === "usage_update") {
    event.type = "usage.updated";
    event.usage = update.usage ?? update;
    event.cost = update.cost;
  }
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
