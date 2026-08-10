import assert from "node:assert/strict";
import test from "node:test";
import { createKimiAdapter } from "./kimi-adapter.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("queues concurrent implicit Kimi turns for the same working directory", async () => {
  const events = [];
  const observed = [];
  let sessionCount = 0;
  const client = {
    async start() {},
    async newSession() {
      sessionCount++;
      return { sessionId: "kimi-session", configOptions: [] };
    },
    async prompt(sessionId, prompt, { onUpdate }) {
      events.push(`${prompt}:start:${sessionId}`);
      onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private" } });
      onUpdate({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read files", status: "running" });
      await delay(20);
      events.push(`${prompt}:end:${sessionId}`);
      return { text: prompt, thoughts: "", toolCalls: [], stopReason: "end_turn" };
    },
    async setConfigOption() {},
    async setMode() {},
    cancel() {},
    stop() {}
  };
  const kimi = createKimiAdapter({ client, log: () => {} });

  const [first, second] = await Promise.all([
    kimi.ask({ cwd: "C:/work", prompt: "first", onEvent: (event) => observed.push(event) }),
    kimi.ask({ cwd: "C:/work", prompt: "second", onEvent: (event) => observed.push(event) })
  ]);

  assert.equal(sessionCount, 1);
  assert.deepEqual(events, [
    "first:start:kimi-session",
    "first:end:kimi-session",
    "second:start:kimi-session",
    "second:end:kimi-session"
  ]);
  assert.equal(first.text, "first");
  assert.equal(second.text, "second");
  assert.ok(observed.some((event) => event.type === "tool.started" && event.title === "Read files"));
  assert.equal(JSON.stringify(observed).includes("private"), false);
});

test("cancels a Kimi turn through its AbortSignal", async () => {
  let rejectPrompt;
  let cancelledSession;
  const client = {
    async start() {},
    async newSession() {
      return { sessionId: "kimi-session", configOptions: [] };
    },
    prompt() {
      return new Promise((resolve, reject) => {
        rejectPrompt = reject;
      });
    },
    cancel(sessionId) {
      cancelledSession = sessionId;
      rejectPrompt(new Error("cancelled by fake client"));
    },
    stop() {}
  };
  const kimi = createKimiAdapter({ client, log: () => {} });
  const controller = new AbortController();
  const turn = kimi.ask({ cwd: "C:/work", prompt: "work", signal: controller.signal });

  await delay(0);
  controller.abort(new Error("stop requested"));

  await assert.rejects(turn, /cancelled by fake client/);
  assert.equal(cancelledSession, "kimi-session");
});
