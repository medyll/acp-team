import assert from "node:assert/strict";
import test from "node:test";
import { createKimiAdapter } from "./kimi-adapter.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("queues concurrent implicit Kimi turns for the same working directory", async () => {
  const events = [];
  let sessionCount = 0;
  const client = {
    async start() {},
    async newSession() {
      sessionCount++;
      return { sessionId: "kimi-session", configOptions: [] };
    },
    async prompt(sessionId, prompt) {
      events.push(`${prompt}:start:${sessionId}`);
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
    kimi.ask({ cwd: "C:/work", prompt: "first" }),
    kimi.ask({ cwd: "C:/work", prompt: "second" })
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
});
