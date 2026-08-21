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

test("pools Kimi clients by cwd and routes status, cancel, and stop", async () => {
  const created = [];
  const cancelled = [];
  const stopped = [];
  const createClient = (cwd) => {
    const clientNumber = created.length + 1;
    const client = {
      async start() {
        return { protocolVersion: 1, agentInfo: { name: "fake-kimi" } };
      },
      async newSession() {
        return {
          sessionId: `session-${clientNumber}`,
          configOptions: [{ id: "model", options: [{ value: "fake-model" }] }]
        };
      },
      async prompt(sessionId, prompt) {
        return { sessionId, text: prompt, thoughts: "", toolCalls: [], stopReason: "end_turn" };
      },
      cancel(sessionId) {
        cancelled.push([cwd, sessionId]);
      },
      stop() {
        stopped.push(cwd);
      }
    };
    created.push([cwd, client]);
    return client;
  };
  const kimi = createKimiAdapter({ createClient, log: () => {} });

  const first = await kimi.ask({ cwd: "C:/project-a", prompt: "one" });
  const sameCwd = await kimi.ask({ cwd: "C:/project-a", prompt: "two" });
  const otherCwd = await kimi.ask({ cwd: "C:/project-b", prompt: "three" });

  assert.deepEqual(created.map(([cwd]) => cwd), ["C:/project-a", "C:/project-b"]);
  assert.equal(first.sessionId, sameCwd.sessionId);
  assert.notEqual(first.sessionId, otherCwd.sessionId);
  const status = await kimi.status();
  assert.deepEqual(status.sessions, [
    { cwd: "C:/project-a", sessionId: first.sessionId },
    { cwd: "C:/project-b", sessionId: otherCwd.sessionId }
  ]);

  kimi.cancel(otherCwd.sessionId);
  assert.deepEqual(cancelled, [["C:/project-b", otherCwd.sessionId]]);
  kimi.stop();
  assert.deepEqual(stopped.sort(), ["C:/project-a", "C:/project-b"]);
});
