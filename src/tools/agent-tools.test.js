import assert from "node:assert/strict";
import test from "node:test";
import { registerAgentTools } from "./agent-tools.js";

/** Captures the handlers registerAgentTools registers, so they can be called directly. */
function harness({ consume, start, ask, watch, list } = {}) {
  const handlers = new Map();
  const server = { registerTool: (name, _config, handler) => handlers.set(name, handler) };
  const started = [];
  const consumed = [];
  registerAgentTools(server, {
    registry: { ids: ["kimi", "codex"], get: () => ({ ask: async (options) => ask?.(options) ?? {} }), list: () => [] },
    runManager: {
      start(options) {
        started.push(options);
        return start?.(options) ?? { runId: `run-${started.length}`, status: "running", events: [] };
      },
      capacity: () => [],
      list(options) {
        return list?.(options) ?? [];
      },
      watch(runId, options) {
        return watch?.(runId, options) ?? { runId, status: "running" };
      }
    },
    usageManager: { record: async () => {} },
    authorizationManager: {
      async consume(request) {
        consumed.push(request);
        if (consume) return consume([request]);
        return { id: "auth-1" };
      },
      async consumeMany(requests) {
        // The real manager validates the whole batch before spending anything,
        // so a rejecting stub must record nothing.
        if (consume) return consume(requests);
        consumed.push(...requests);
        return requests.map(() => ({ id: "auth-1" }));
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

test("a write-capable fan-out authorizes every agent in one batch", async () => {
  const { call, consumed, started } = harness();
  await call("agent_fanout", { prompt: "fix", agents: ["kimi", "codex"], mode: "default", authorization: "auth_x" });
  assert.deepEqual(consumed.map((request) => request.agent), ["kimi", "codex"]);
  assert.ok(consumed.every((request) => request.cwd === "/work" && request.mode === "default" && request.token === "auth_x"));
  assert.equal(started.length, 2);
});

test("a token that does not cover every agent starts no run and spends nothing", async () => {
  const { call, started, consumed } = harness({
    consume: () => {
      throw new Error("Authorization is scoped to agent kimi");
    }
  });
  await assert.rejects(
    call("agent_fanout", { prompt: "fix", agents: ["kimi", "codex"], mode: "default", authorization: "auth_x" }),
    /Authorization does not cover this fan-out.*at least 2 uses/s
  );
  assert.equal(started.length, 0, "no agent may start once the fan-out is known to be under-authorized");
  assert.equal(consumed.length, 0, "a refused batch spends no uses");
});

test("the fan-out asks for its agents as a single batch, not one call per agent", async () => {
  const batches = [];
  const { call } = harness({
    consume: (requests) => {
      batches.push(requests.map((request) => request.agent));
      return requests.map(() => ({ id: "auth-1" }));
    }
  });
  await call("agent_fanout", { prompt: "fix", agents: ["kimi", "codex", "kimi"], mode: "default", authorization: "auth_x" });
  assert.deepEqual(batches, [["kimi", "codex"]], "duplicate agents collapse and the batch is atomic");
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

const askResult = {
  sessionId: "session-1",
  text: "Done",
  thoughts: "private reasoning",
  toolCalls: [
    { status: "completed", title: "Read alpha" },
    { status: "completed", title: "Read beta" },
    { status: "failed", title: "Run gamma" }
  ],
  stopReason: "end_turn"
};

test("agent_ask defaults to a compact tool-call summary", async () => {
  const { call } = harness({ ask: async () => askResult });
  const response = await call("agent_ask", { agent: "kimi", prompt: "inspect", mode: "plan" });
  const text = response.content[0].text;

  assert.match(text, /kimi tool calls: completed=2, failed=1/);
  assert.doesNotMatch(text, /Read alpha|Read beta|Run gamma|private reasoning/);
  assert.match(text, /\(agent: kimi, session: session-1, stop: end_turn\)$/);
});

test("agent_ask return full preserves the detailed tool-call list", async () => {
  const { call } = harness({ ask: async () => askResult });
  const response = await call("agent_ask", { agent: "kimi", prompt: "inspect", mode: "plan", return: "full" });
  const text = response.content[0].text;

  assert.match(text, /- \[completed\] Read alpha/);
  assert.match(text, /- \[failed\] Run gamma/);
  assert.doesNotMatch(text, /private reasoning/);
});

test("agent_ask include_thoughts implies a full response", async () => {
  const { call } = harness({ ask: async () => askResult });
  const response = await call("agent_ask", {
    agent: "kimi",
    prompt: "inspect",
    mode: "plan",
    return: "summary",
    include_thoughts: true
  });
  const text = response.content[0].text;

  assert.match(text, /- \[completed\] Read alpha/);
  assert.match(text, /kimi thoughts:\nprivate reasoning/);
});

test("agent_watch returns a compact report by default and events on request", async () => {
  const calls = [];
  const { call } = harness({
    watch: (runId, options) => {
      calls.push([runId, options]);
      return { runId, status: "running", elapsedMs: 12_000, ...(options.includeEvents ? { events: [] } : {}) };
    }
  });

  const summary = JSON.parse((await call("agent_watch", { run_id: "run-1" })).content[0].text);
  const events = JSON.parse((await call("agent_watch", { run_id: "run-1", return: "events" })).content[0].text);

  assert.equal("events" in summary, false);
  assert.deepEqual(events.events, []);
  assert.deepEqual(calls, [
    ["run-1", { afterEvent: 0, waitMs: 0, until: "event", includeEvents: false }],
    ["run-1", { afterEvent: 0, waitMs: 0, until: "event", includeEvents: true }]
  ]);
});

test("agent_status requests only active run summaries", async () => {
  const listCalls = [];
  const { call } = harness({ list: (options) => (listCalls.push(options), []) });

  await call("agent_status", {});

  assert.deepEqual(listCalls, [{ agent: undefined, activeOnly: true }]);
});
