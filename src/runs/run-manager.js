import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = new Set(["running", "cancelling"]);
const DEFAULT_MAX_CONCURRENT_PER_AGENT = 2;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_QUIET_AFTER_MS = 30_000;
const DEFAULT_STALLED_AFTER_MS = 90_000;
const MESSAGE_PREVIEW_LIMIT = 500;

/**
 * Keep delegated turns observable and controllable independently from the MCP
 * request that launched them. Live run state stays in memory — its lifetime
 * matches the bridge process and the agent sessions it owns — while an optional
 * journal records lifecycle transitions so a restart still has an audit trail.
 */
export function createRunManager({
  registry,
  usageManager,
  maxEvents = 500,
  maxRuns = 200,
  maxConcurrentPerAgent = DEFAULT_MAX_CONCURRENT_PER_AGENT,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  quietAfterMs = DEFAULT_QUIET_AFTER_MS,
  stalledAfterMs = DEFAULT_STALLED_AFTER_MS,
  now = Date.now,
  journal
}) {
  const runs = new Map();
  const pending = new Map();

  function concurrencyLimit(agent) {
    const configured =
      typeof maxConcurrentPerAgent === "object" && maxConcurrentPerAgent !== null
        ? maxConcurrentPerAgent[agent] ?? maxConcurrentPerAgent.default
        : maxConcurrentPerAgent;
    return Number.isFinite(configured) && configured > 0 ? configured : Infinity;
  }

  function activeCount(agent) {
    let count = 0;
    for (const run of runs.values()) {
      if (run.agent === agent && ACTIVE_STATES.has(run.status)) count += 1;
    }
    return count;
  }

  function record(run, event) {
    journal?.record({
      runId: run.runId,
      agent: run.agent,
      status: run.status,
      sessionId: run.sessionId,
      event
    });
  }

  function append(run, type, data = {}) {
    const event = {
      seq: ++run.lastEvent,
      at: new Date(now()).toISOString(),
      type,
      ...data
    };
    observe(run, event);
    run.events.push(event);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    if (type.startsWith("run.")) record(run, event);
    for (const wake of run.waiters) wake();
    run.waiters.clear();
    return event;
  }

  function publicRun(run, { afterEvent = 0, includeEvents = true } = {}) {
    const timing = timingFor(run);
    return {
      runId: run.runId,
      agent: run.agent,
      status: run.status,
      sessionId: run.sessionId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastEvent: run.lastEvent,
      lastActivityAt: run.lastActivityAt,
      health: healthFor(run, timing.idleMs),
      phase: phaseFor(run),
      elapsedMs: timing.elapsedMs,
      queueMs: timing.queueMs,
      activeMs: timing.activeMs,
      idleMs: timing.idleMs,
      lastMessage: run.lastMessage,
      currentTool: currentToolFor(run),
      toolCalls: toolCountsFor(run),
      ...(includeEvents ? { events: run.events.filter((event) => event.seq > afterEvent) } : {}),
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {})
    };
  }

  function get(runId) {
    const run = runs.get(runId);
    if (!run) throw new Error(`Unknown run "${runId}".`);
    return run;
  }

  function start({ agent, ...askOptions }) {
    if (runs.size >= maxRuns) {
      const oldestFinished = [...runs.values()].find((candidate) => TERMINAL_STATES.has(candidate.status));
      if (oldestFinished) runs.delete(oldestFinished.runId);
      else throw new Error(`Run capacity reached (${maxRuns} active runs). Stop or wait for a run before starting another.`);
    }
    registry.get(agent);
    const controller = new AbortController();
    const run = {
      runId: randomUUID(),
      agent,
      status: "queued",
      sessionId: askOptions.sessionId ?? null,
      createdAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      lastActivityAt: null,
      phase: "queued",
      lastMessage: null,
      lastEvent: 0,
      events: [],
      tools: new Map(),
      heartbeatTimer: null,
      result: null,
      error: null,
      controller,
      waiters: new Set()
    };
    runs.set(run.runId, run);
    run.askOptions = askOptions;
    append(run, "run.queued");

    // A busy agent is a slow agent: hold extra work here rather than letting an
    // unbounded number of CLI subprocesses compete for the same runtime.
    if (activeCount(agent) >= concurrencyLimit(agent)) {
      queueFor(agent).push(run);
      append(run, "run.waiting", { reason: `agent ${agent} is at its concurrency limit` });
    } else {
      admit(run);
    }

    return publicRun(run);
  }

  function queueFor(agent) {
    if (!pending.has(agent)) pending.set(agent, []);
    return pending.get(agent);
  }

  function drain(agent) {
    const queue = pending.get(agent);
    if (!queue?.length) return;
    while (queue.length && activeCount(agent) < concurrencyLimit(agent)) {
      admit(queue.shift());
    }
  }

  function admit(run) {
    const { agent, askOptions, controller } = run;
    const adapter = registry.get(agent);
    run.status = "running";
    run.startedAt = new Date(now()).toISOString();
    append(run, "run.admitted");
    startHeartbeat(run);

    // Deliberately detach execution from the MCP call that created the run.
    run.promise = Promise.resolve().then(async () => {
      try {
        const result = await adapter.ask({
          ...askOptions,
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "session.started" && event.sessionId) run.sessionId = event.sessionId;
            append(run, event.type, event);
          }
        });

        if (controller.signal.aborted) {
          run.status = "cancelled";
          run.finishedAt = new Date(now()).toISOString();
          clearHeartbeat(run);
          append(run, "run.cancelled");
        } else {
          run.status = "completed";
          run.sessionId = result.sessionId ?? run.sessionId;
          const { thoughts: _privateThoughts, ...publicResult } = result;
          run.result = publicResult;
          run.finishedAt = new Date(now()).toISOString();
          clearHeartbeat(run);
          await usageManager?.record({
            agent: run.agent,
            model: askOptions.model,
            sessionId: run.sessionId,
            runId: run.runId,
            usage: result.usage,
            cost: result.cost,
            outcome: "completed",
            latencyMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt)
          }).catch(() => {});
          append(run, "run.completed", { sessionId: run.sessionId });
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          run.status = "cancelled";
          run.finishedAt = new Date(now()).toISOString();
          clearHeartbeat(run);
          append(run, "run.cancelled");
        } else {
          run.status = "failed";
          run.error = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
          run.finishedAt = new Date(now()).toISOString();
          clearHeartbeat(run);
          await usageManager?.record({
            agent: run.agent,
            model: askOptions.model,
            sessionId: run.sessionId,
            runId: run.runId,
            outcome: "failed",
            latencyMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
            source: "bridge-observed"
          }).catch(() => {});
          append(run, "run.failed", { error: run.error });
        }
      } finally {
        drain(run.agent);
      }
    });
  }

  /**
   * `until: "event"` settles on the first new event — right for tailing a run.
   * `until: "terminal"` keeps waiting until the run finishes, so a chatty run
   * costs one round trip instead of one per event; the mandator still gets every
   * event it has not seen yet in the reply. Both are bounded by waitMs.
   */
  async function watch(runId, { afterEvent = 0, waitMs = 0, until = "event", includeEvents = true } = {}) {
    const run = get(runId);
    const deadline = Date.now() + waitMs;
    while (waitMs > 0 && !TERMINAL_STATES.has(run.status)) {
      if (until !== "terminal" && run.lastEvent > afterEvent) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          run.waiters.delete(done);
          resolve();
        }
        run.waiters.add(done);
      });
    }
    return publicRun(run, { afterEvent, includeEvents });
  }

  function stop(runId) {
    const run = get(runId);
    if (TERMINAL_STATES.has(run.status)) return publicRun(run);
    append(run, "run.stop_requested");

    // A run still waiting for a slot has no adapter work to interrupt: drop it
    // from the queue and settle it here, or nothing would ever resolve it.
    const queue = pending.get(run.agent);
    const waitingAt = queue?.indexOf(run) ?? -1;
    if (waitingAt >= 0) {
      queue.splice(waitingAt, 1);
      run.controller.abort(new Error("Stopped by mandator"));
      run.status = "cancelled";
      run.finishedAt = new Date(now()).toISOString();
      append(run, "run.cancelled");
      return publicRun(run);
    }

    run.status = "cancelling";
    clearHeartbeat(run);
    run.controller.abort(new Error("Stopped by mandator"));
    return publicRun(run);
  }

  function list({ agent, activeOnly = false } = {}) {
    return [...runs.values()]
      .filter((run) => (!agent || run.agent === agent) && (!activeOnly || !TERMINAL_STATES.has(run.status)))
      .map((run) => publicRun(run, { includeEvents: false }));
  }

  function show(runId) {
    return publicRun(get(runId));
  }

  function retryScope(runId) {
    const run = get(runId);
    if (!TERMINAL_STATES.has(run.status)) throw new Error("Only a finished run can be retried");
    return { agent: run.agent, cwd: run.askOptions.cwd, mode: run.askOptions.mode ?? "plan" };
  }

  function retry(runId) {
    const run = get(runId);
    retryScope(runId);
    return start({
      agent: run.agent,
      ...run.askOptions,
      sessionId: undefined,
      newSession: true
    });
  }

  function stopAll() {
    for (const run of runs.values()) {
      if (!TERMINAL_STATES.has(run.status)) stop(run.runId);
    }
  }

  function capacity() {
    const agents = new Set([...[...runs.values()].map((run) => run.agent), ...pending.keys()]);
    return [...agents].map((agent) => ({
      agent,
      active: activeCount(agent),
      waiting: pending.get(agent)?.length ?? 0,
      limit: concurrencyLimit(agent)
    }));
  }

  function startHeartbeat(run) {
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return;
    run.heartbeatTimer = setInterval(() => {
      if (run.status !== "running") return clearHeartbeat(run);
      const timing = timingFor(run);
      append(run, "agent.heartbeat", {
        elapsedMs: timing.elapsedMs,
        idleMs: timing.idleMs,
        health: healthFor(run, timing.idleMs),
        phase: phaseFor(run)
      });
    }, heartbeatMs);
    run.heartbeatTimer.unref?.();
  }

  function clearHeartbeat(run) {
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.heartbeatTimer = null;
  }

  function observe(run, event) {
    if (event.type === "agent.heartbeat") return;
    run.lastActivityAt = event.at;

    if (event.type === "message.delta" && event.text) {
      run.lastMessage = `${run.lastMessage ?? ""}${event.text}`.slice(-MESSAGE_PREVIEW_LIMIT);
      run.phase = "message";
    } else if (event.type === "thought.updated") {
      run.phase = "thinking";
    } else if (event.type === "session.started") {
      run.phase = "session";
    } else if (event.type === "usage.updated") {
      run.phase = "usage";
    }

    if (event.type === "tool.started" || event.type === "tool.updated") {
      const key = event.toolCallId ?? event.title ?? `tool-${event.seq}`;
      const previous = run.tools.get(key) ?? {};
      run.tools.set(key, {
        toolCallId: event.toolCallId ?? previous.toolCallId,
        title: event.title ?? previous.title ?? "Unknown tool",
        status: event.status ?? previous.status ?? "running"
      });
      run.phase = currentToolFor(run) ? "tool" : "running";
    }

    if (event.type === "run.queued" || event.type === "run.waiting") run.phase = "queued";
    if (event.type === "run.admitted" || event.type === "turn.started") run.phase = "running";
    if (event.type === "run.stop_requested") run.phase = "cancelling";
  }

  function timingFor(run) {
    const current = now();
    const created = Date.parse(run.createdAt);
    const started = run.startedAt ? Date.parse(run.startedAt) : null;
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : null;
    const end = finished ?? current;
    const lastActivity = run.lastActivityAt ? Date.parse(run.lastActivityAt) : created;
    return {
      elapsedMs: Math.max(0, end - created),
      queueMs: Math.max(0, (started ?? end) - created),
      activeMs: started === null ? 0 : Math.max(0, end - started),
      idleMs: Math.max(0, end - lastActivity)
    };
  }

  function healthFor(run, idleMs) {
    if (TERMINAL_STATES.has(run.status)) return run.status;
    if (run.status === "queued") return "queued";
    if (run.status === "cancelling") return "cancelling";
    if (idleMs >= stalledAfterMs) return "stalled";
    if (idleMs >= quietAfterMs) return "quiet";
    return "active";
  }

  function phaseFor(run) {
    if (TERMINAL_STATES.has(run.status)) return run.status;
    if (run.status === "cancelling") return "cancelling";
    if (run.status === "queued") return "queued";
    return currentToolFor(run) ? "tool" : run.phase;
  }

  function currentToolFor(run) {
    return [...run.tools.values()].find((tool) => ["running", "pending", "in_progress"].includes(tool.status)) ?? null;
  }

  function toolCountsFor(run) {
    const counts = {};
    for (const tool of run.tools.values()) counts[tool.status] = (counts[tool.status] ?? 0) + 1;
    return counts;
  }

  return { start, watch, stop, list, show, retry, retryScope, stopAll, capacity };
}
