import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = new Set(["running", "cancelling"]);
const DEFAULT_MAX_CONCURRENT_PER_AGENT = 2;

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
      at: new Date().toISOString(),
      type,
      ...data
    };
    run.events.push(event);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    if (type.startsWith("run.")) record(run, event);
    for (const wake of run.waiters) wake();
    run.waiters.clear();
    return event;
  }

  function publicRun(run, { afterEvent = 0, includeEvents = true } = {}) {
    return {
      runId: run.runId,
      agent: run.agent,
      status: run.status,
      sessionId: run.sessionId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastEvent: run.lastEvent,
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
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      lastEvent: 0,
      events: [],
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
    run.startedAt = new Date().toISOString();
    append(run, "run.admitted");

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
          run.finishedAt = new Date().toISOString();
          append(run, "run.cancelled");
        } else {
          run.status = "completed";
          run.sessionId = result.sessionId ?? run.sessionId;
          const { thoughts: _privateThoughts, ...publicResult } = result;
          run.result = publicResult;
          run.finishedAt = new Date().toISOString();
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
          run.finishedAt = new Date().toISOString();
          append(run, "run.cancelled");
        } else {
          run.status = "failed";
          run.error = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
          run.finishedAt = new Date().toISOString();
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

  async function watch(runId, { afterEvent = 0, waitMs = 0 } = {}) {
    const run = get(runId);
    if (waitMs > 0 && run.lastEvent <= afterEvent && !TERMINAL_STATES.has(run.status)) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() {
          clearTimeout(timer);
          run.waiters.delete(done);
          resolve();
        }
        run.waiters.add(done);
      });
    }
    return publicRun(run, { afterEvent });
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
      run.finishedAt = new Date().toISOString();
      append(run, "run.cancelled");
      return publicRun(run);
    }

    run.status = "cancelling";
    run.controller.abort(new Error("Stopped by mandator"));
    return publicRun(run);
  }

  function list({ agent } = {}) {
    return [...runs.values()]
      .filter((run) => !agent || run.agent === agent)
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

  return { start, watch, stop, list, show, retry, retryScope, stopAll, capacity };
}
