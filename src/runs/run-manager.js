import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * Keep delegated turns observable and controllable independently from the MCP
 * request that launched them. Runs intentionally live in memory: their lifetime
 * matches the bridge process and the agent sessions it owns.
 */
export function createRunManager({ registry, maxEvents = 500, maxRuns = 200 }) {
  const runs = new Map();

  function append(run, type, data = {}) {
    const event = {
      seq: ++run.lastEvent,
      at: new Date().toISOString(),
      type,
      ...data
    };
    run.events.push(event);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
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
    }
    const adapter = registry.get(agent);
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
    append(run, "run.queued");

    // Deliberately detach execution from the MCP call that created the run.
    run.promise = Promise.resolve().then(async () => {
      try {
        const result = await adapter.ask({
          ...askOptions,
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "turn.started" && !run.startedAt) {
              run.status = "running";
              run.startedAt = new Date().toISOString();
            }
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
          append(run, "run.failed", { error: run.error });
        }
      }
    });

    return publicRun(run);
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
    run.status = "cancelling";
    append(run, "run.stop_requested");
    run.controller.abort(new Error("Stopped by mandator"));
    return publicRun(run);
  }

  function list({ agent } = {}) {
    return [...runs.values()]
      .filter((run) => !agent || run.agent === agent)
      .map((run) => publicRun(run, { includeEvents: false }));
  }

  function stopAll() {
    for (const run of runs.values()) {
      if (!TERMINAL_STATES.has(run.status)) stop(run.runId);
    }
  }

  return { start, watch, stop, list, stopAll };
}
