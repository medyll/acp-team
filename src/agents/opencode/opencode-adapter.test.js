import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeAdapter } from "./opencode-adapter.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("maps common bridge modes onto OpenCode build and plan modes", async () => {
  const calls = [];
  const client = {
    async start() {},
    async newSession(options) {
      calls.push(["newSession", options.mode]);
      return { sessionId: "open-session", configOptions: [] };
    },
    async setMode(sessionId, mode) {
      calls.push(["setMode", sessionId, mode]);
    },
    async prompt(sessionId, prompt) {
      return { sessionId, text: prompt, thoughts: "", toolCalls: [], stopReason: "end_turn" };
    },
    cancel() {},
    stop() {}
  };
  const opencode = createOpenCodeAdapter({
    client,
    defaultMode: "default",
    permissionPolicy: "deny",
    log: () => {}
  });

  const first = await opencode.ask({ cwd: "C:/work", prompt: "one" });
  const second = await opencode.ask({ cwd: "C:/work", prompt: "two", mode: "plan" });

  assert.equal(opencode.id, "opencode");
  assert.equal(first.sessionId, "open-session");
  assert.equal(second.sessionId, "open-session");
  assert.deepEqual(calls, [
    ["newSession", "build"],
    ["setMode", "open-session", "plan"]
  ]);
});

test("rejects removed unsandboxed modes before reaching ACP", async () => {
  const opencode = createOpenCodeAdapter({
    client: { start: async () => { throw new Error("must not start"); } },
    defaultMode: "default",
    log: () => {}
  });
  await assert.rejects(() => opencode.ask({ cwd: "C:/work", prompt: "go", mode: "yolo" }), /Unsupported agent mode/);
});

test("evicts an idle OpenCode client before recreating it for the same cwd", async () => {
  const created = [];
  const stopped = [];
  const createClient = (cwd) => {
    const clientNumber = created.length + 1;
    const client = {
      async start() {},
      async newSession() {
        return { sessionId: `open-${clientNumber}`, configOptions: [] };
      },
      async prompt(sessionId, prompt) {
        return { sessionId, text: prompt, thoughts: "", toolCalls: [], stopReason: "end_turn" };
      },
      cancel() {},
      stop() {
        stopped.push(clientNumber);
      }
    };
    created.push([cwd, client]);
    return client;
  };
  const opencode = createOpenCodeAdapter({ createClient, clientIdleTimeoutMs: 10, log: () => {} });

  const first = await opencode.ask({ cwd: "C:/idle-project", prompt: "one" });
  await delay(30);
  const second = await opencode.ask({ cwd: "C:/idle-project", prompt: "two" });

  assert.deepEqual(created.map(([cwd]) => cwd), ["C:/idle-project", "C:/idle-project"]);
  assert.deepEqual(stopped, [1]);
  assert.notEqual(first.sessionId, second.sessionId);
  opencode.stop();
});

