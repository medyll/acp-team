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
