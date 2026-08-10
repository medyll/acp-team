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
  assert.equal(created.status, "queued");
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
