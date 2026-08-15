import assert from "node:assert/strict";
import test from "node:test";
import { registerAgentTools } from "./agent-tools.js";

/** Captures the handlers registerAgentTools registers, so they can be called directly. */
function harness({ consume, start } = {}) {
  const handlers = new Map();
  const server = { registerTool: (name, _config, handler) => handlers.set(name, handler) };
  const started = [];
  const consumed = [];
  registerAgentTools(server, {
    registry: { ids: ["kimi", "codex"], get: () => ({ ask: async () => ({}) }), list: () => [] },
    runManager: {
      start(options) {
        started.push(options);
        return start?.(options) ?? { runId: `run-${started.length}`, status: "running", events: [] };
      },
      capacity: () => [],
      list: () => []
    },
    usageManager: { record: async () => {} },
    authorizationManager: {
      async consume(request) {
        consumed.push(request);
        if (consume) return consume(request, consumed.length);
        return { id: "auth-1" };
      }
    },
    defaultCwd: "/work",
    log: { warn: () => {} }
  });
  return { call: (name, input) => handlers.get(name)(input, {}), started, consumed };
}

test("a fan-out in plan mode needs no authorization at all", async () => {
  const { call, started, consumed } = harness();
  const response = await call("agent_fanout", { prompt: "compare", agents: ["kimi", "codex"], mode: "plan" });
  assert.equal(consumed.length, 0);
  assert.equal(started.length, 2);
  assert.deepEqual(JSON.parse(response.content[0].text).runs.map((run) => run.agent), ["kimi", "codex"]);
});

test("a write-capable fan-out consumes one use per agent", async () => {
  const { call, consumed, started } = harness();
  await call("agent_fanout", { prompt: "fix", agents: ["kimi", "codex"], mode: "default", authorization: "auth_x" });
  assert.deepEqual(consumed.map((request) => request.agent), ["kimi", "codex"]);
  assert.ok(consumed.every((request) => request.cwd === "/work" && request.mode === "default" && request.token === "auth_x"));
  assert.equal(started.length, 2);
});

test("a token that does not cover every agent starts no run at all", async () => {
  // A token scoped to one agent, or with one use, previously let the first agent
  // write while the rest were refused — a partial fan-out nobody approved.
  const { call, started } = harness({
    consume: (_request, attempt) => {
      if (attempt > 1) throw new Error("Authorization is scoped to agent kimi");
      return { id: "auth-1" };
    }
  });
  await assert.rejects(
    call("agent_fanout", { prompt: "fix", agents: ["kimi", "codex"], mode: "default", authorization: "auth_x" }),
    /Authorization does not cover this fan-out \(codex\).*at least 2 uses/s
  );
  assert.equal(started.length, 0, "no agent may start once the fan-out is known to be under-authorized");
});

test("an agent that cannot start does not sink the rest of the comparison", async () => {
  const { call } = harness({
    start: (options) => {
      if (options.agent === "kimi") throw new Error("Run capacity reached");
      return { runId: "run-codex", status: "running", events: [] };
    }
  });
  const response = await call("agent_fanout", { prompt: "compare", agents: ["kimi", "codex"], mode: "plan" });
  const { runs } = JSON.parse(response.content[0].text);
  assert.equal(runs.find((run) => run.agent === "kimi").status, "rejected");
  assert.equal(runs.find((run) => run.agent === "codex").status, "running");
});

test("write-capable single delegations are authorized before the agent is reached", async () => {
  const { call, consumed } = harness();
  await call("agent_start", { agent: "codex", prompt: "fix", mode: "default", authorization: "auth_x" });
  assert.deepEqual(consumed, [{ token: "auth_x", agent: "codex", cwd: "/work", mode: "default" }]);
});

test("an unsupported mode is refused before any authorization is spent", async () => {
  const { call, consumed, started } = harness();
  await assert.rejects(call("agent_start", { agent: "codex", prompt: "go", mode: "yolo" }), /Unsupported agent mode/);
  assert.equal(consumed.length, 0);
  assert.equal(started.length, 0);
});
