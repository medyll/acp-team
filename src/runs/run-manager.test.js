import assert from "node:assert/strict";
import test from "node:test";
import { createRunManager } from "./run-manager.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registryFor(adapter) {
  return { get: () => adapter };
}

test("starts immediately and exposes live events plus the final result", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = {
    async ask({ onEvent }) {
      onEvent({ type: "turn.started" });
      onEvent({ type: "session.started", sessionId: "session-1" });
      onEvent({ type: "tool.started", title: "Read files" });
      await gate;
      return {
        sessionId: "session-1",
        text: "done",
        thoughts: "private reasoning",
        toolCalls: [],
        stopReason: "end_turn"
      };
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter) });

  const created = manager.start({ agent: "fake", prompt: "work" });
  assert.equal(created.status, "running");
  await delay(0);

  const live = await manager.watch(created.runId);
  assert.equal(live.status, "running");
  assert.equal(live.sessionId, "session-1");
  assert.ok(live.events.some((event) => event.type === "tool.started"));

  release();
  const completed = await manager.watch(created.runId, { afterEvent: live.lastEvent, waitMs: 100 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.text, "done");
  assert.equal("thoughts" in completed.result, false);
  assert.ok(completed.finishedAt);
});

test("stops a run before an agent session id exists", async () => {
  const adapter = {
    async ask({ signal, onEvent }) {
      onEvent({ type: "turn.started" });
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter) });
  const created = manager.start({ agent: "fake", prompt: "work" });
  await delay(0);

  const stopping = manager.stop(created.runId);
  assert.equal(stopping.status, "cancelling");
  const stopped = await manager.watch(created.runId, { afterEvent: stopping.lastEvent, waitMs: 100 });
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.events.some((event) => event.type === "run.cancelled"));
});

test("enforces a hard cap when every retained run is active", () => {
  const adapter = { ask: async () => new Promise(() => {}) };
  const manager = createRunManager({ registry: registryFor(adapter), maxRuns: 1 });
  manager.start({ agent: "fake", prompt: "first" });
  assert.throws(() => manager.start({ agent: "fake", prompt: "second" }), /capacity reached/);
  manager.stopAll();
});

test("holds work past an agent's concurrency limit and admits it when a slot frees", async () => {
  const gates = [];
  const adapter = {
    ask() {
      return new Promise((resolve) => {
        gates.push(() => resolve({ sessionId: "s", text: "ok", thoughts: "", toolCalls: [], stopReason: "end_turn" }));
      });
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter), maxConcurrentPerAgent: 1 });

  const first = manager.start({ agent: "fake", prompt: "first" });
  const second = manager.start({ agent: "fake", prompt: "second" });
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.ok(second.events.some((event) => event.type === "run.waiting"));
  assert.deepEqual(manager.capacity(), [{ agent: "fake", active: 1, waiting: 1, limit: 1 }]);
  await delay(0);
  assert.equal(gates.length, 1, "the second run must not reach the adapter while the first holds the slot");

  gates[0]();
  const promoted = await manager.watch(second.runId, { afterEvent: second.lastEvent, waitMs: 100 });
  assert.equal(promoted.status, "running");
  assert.equal(gates.length, 2);
  manager.stopAll();
});

test("per-agent limits are independent", () => {
  const manager = createRunManager({
    registry: { get: () => ({ ask: () => new Promise(() => {}) }) },
    maxConcurrentPerAgent: { default: 1, kimi: 2 }
  });
  manager.start({ agent: "kimi", prompt: "a" });
  const second = manager.start({ agent: "kimi", prompt: "b" });
  const third = manager.start({ agent: "kimi", prompt: "c" });
  const other = manager.start({ agent: "codex", prompt: "d" });
  assert.equal(second.status, "running");
  assert.equal(third.status, "queued");
  assert.equal(other.status, "running", "a busy agent must not block a different one");
  manager.stopAll();
});

test("stops a run that never got a slot", async () => {
  const manager = createRunManager({
    registry: registryFor({ ask: () => new Promise(() => {}) }),
    maxConcurrentPerAgent: 1
  });
  manager.start({ agent: "fake", prompt: "holds the slot" });
  const waiting = manager.start({ agent: "fake", prompt: "never runs" });

  const stopped = manager.stop(waiting.runId);
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.finishedAt);
  assert.deepEqual(manager.capacity(), [{ agent: "fake", active: 1, waiting: 0, limit: 1 }]);
  manager.stopAll();
});

test("journals run lifecycle transitions without exposing agent output", async () => {
  const recorded = [];
  const manager = createRunManager({
    registry: registryFor({
      async ask() {
        return { sessionId: "s-1", text: "secret answer", thoughts: "", toolCalls: [], stopReason: "end_turn" };
      }
    }),
    journal: { record: (entry) => recorded.push(entry) }
  });
  const run = manager.start({ agent: "fake", prompt: "work" });
  await manager.watch(run.runId, { afterEvent: run.lastEvent, waitMs: 100 });

  const events = recorded.map((entry) => entry.event.type);
  assert.deepEqual(events, ["run.queued", "run.admitted", "run.completed"]);
  assert.ok(recorded.every((entry) => entry.runId === run.runId));
  assert.equal(JSON.stringify(recorded).includes("secret answer"), false);
});

test("until=terminal waits past intermediate events, until=event returns on the first one", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = {
    async ask({ onEvent }) {
      onEvent({ type: "turn.started" });
      onEvent({ type: "tool.started", title: "step 1" });
      onEvent({ type: "tool.started", title: "step 2" });
      await gate;
      return { sessionId: "s-1", text: "done", thoughts: "", toolCalls: [], stopReason: "end_turn" };
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter) });
  const run = manager.start({ agent: "fake", prompt: "work" });

  // Default mode settles as soon as the run emits something, run still going.
  const tailed = await manager.watch(run.runId, { afterEvent: run.lastEvent, waitMs: 200 });
  assert.equal(tailed.status, "running");

  // terminal mode ignores those same intermediate events and only returns at the end.
  const settled = manager.watch(run.runId, { afterEvent: tailed.lastEvent, waitMs: 200, until: "terminal" });
  await delay(10);
  release();
  const finished = await settled;
  assert.equal(finished.status, "completed");
  assert.equal(finished.result.text, "done");
});

test("until=terminal still honours its wait_ms budget on a run that never finishes", async () => {
  const adapter = {
    async ask({ signal, onEvent }) {
      onEvent({ type: "turn.started" });
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter) });
  const run = manager.start({ agent: "fake", prompt: "work" });
  await delay(0);

  const startedAt = Date.now();
  const pendingRun = await manager.watch(run.runId, { afterEvent: run.lastEvent, waitMs: 60, until: "terminal" });
  assert.equal(pendingRun.status, "running");
  assert.ok(Date.now() - startedAt >= 55, "should have waited for the whole budget");
  manager.stopAll();
});

test("retries a retained finished run as a fresh session", async () => {
  const calls = [];
  const adapter = {
    async ask(options) {
      calls.push(options);
      return { sessionId: `s-${calls.length}`, text: "done", thoughts: "", toolCalls: [] };
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter) });
  const first = manager.start({ agent: "fake", prompt: "work", cwd: "C:/work", mode: "plan" });
  await delay(0);
  const retried = manager.retry(first.runId);
  await delay(0);
  assert.notEqual(retried.runId, first.runId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].newSession, true);
  assert.equal(calls[1].prompt, "work");
});

test("reports elapsed time, health, visible messages and tool activity", async () => {
  let clock = 0;
  let release;
  let emit;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = {
    async ask({ onEvent }) {
      emit = onEvent;
      onEvent({ type: "turn.started" });
      onEvent({ type: "message.delta", text: "Inspecting " });
      onEvent({ type: "message.delta", text: "the run manager." });
      onEvent({ type: "tool.started", toolCallId: "tool-1", title: "Read files", status: "running" });
      await gate;
      return { sessionId: "s-1", text: "done", thoughts: "", toolCalls: [], stopReason: "end_turn" };
    }
  };
  const manager = createRunManager({
    registry: registryFor(adapter),
    heartbeatMs: 0,
    quietAfterMs: 20_000,
    stalledAfterMs: 60_000,
    now: () => clock
  });
  const run = manager.start({ agent: "fake", prompt: "work" });
  await delay(0);

  clock = 15_000;
  const active = await manager.watch(run.runId, { includeEvents: false });
  assert.equal(active.elapsedMs, 15_000);
  assert.equal(active.queueMs, 0);
  assert.equal(active.activeMs, 15_000);
  assert.equal(active.idleMs, 15_000);
  assert.equal(active.health, "active");
  assert.equal(active.phase, "tool");
  assert.equal(active.lastMessage, "Inspecting the run manager.");
  assert.deepEqual(active.currentTool, { toolCallId: "tool-1", title: "Read files", status: "running" });
  assert.deepEqual(active.toolCalls, { running: 1 });
  assert.equal("events" in active, false);

  clock = 25_000;
  assert.equal((await manager.watch(run.runId, { includeEvents: false })).health, "quiet");
  clock = 65_000;
  assert.equal((await manager.watch(run.runId, { includeEvents: false })).health, "stalled");

  emit({ type: "tool.updated", toolCallId: "tool-1", status: "completed" });
  const resumed = await manager.watch(run.runId, { includeEvents: false });
  assert.equal(resumed.health, "active");
  assert.equal(resumed.currentTool, null);
  assert.deepEqual(resumed.toolCalls, { completed: 1 });
  release();
  await manager.watch(run.runId, { afterEvent: resumed.lastEvent, waitMs: 100 });
});

test("emits bounded heartbeats while a supervised run is active", async () => {
  const adapter = {
    async ask({ signal }) {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter), heartbeatMs: 5 });
  const run = manager.start({ agent: "fake", prompt: "work" });
  const heartbeat = await manager.watch(run.runId, { afterEvent: run.lastEvent, waitMs: 40 });

  assert.ok(heartbeat.events.some((event) => event.type === "agent.heartbeat"));
  assert.equal(heartbeat.status, "running");
  manager.stop(run.runId);
  await manager.watch(run.runId, { afterEvent: heartbeat.lastEvent, waitMs: 100 });
});

test("can list only non-terminal runs for aggregate status", async () => {
  const adapter = {
    async ask() {
      return { sessionId: "s-1", text: "done", thoughts: "", toolCalls: [], stopReason: "end_turn" };
    }
  };
  const manager = createRunManager({ registry: registryFor(adapter), heartbeatMs: 0 });
  manager.start({ agent: "fake", prompt: "work" });
  await delay(0);

  assert.equal(manager.list().length, 1);
  assert.equal(manager.list({ activeOnly: true }).length, 0);
});
