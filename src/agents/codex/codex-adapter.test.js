import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { absorbItem, createCodexAdapter, normalizeCodexEvent } from "./codex-adapter.js";

/** Minimal stand-in for a `codex exec` process we can drive line by line. */
function fakeCodex() {
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => {
      proc.killed = true;
      proc.emit("close", 1);
    };
    const record = { bin, args, options, proc };
    spawned.push(record);
    record.emit = (event) => proc.stdout.write(`${JSON.stringify(event)}\n`);
    record.finish = (code = 0) => {
      proc.stdout.end();
      queueMicrotask(() => proc.emit("close", code));
    };
    return proc;
  };
  return { spawned, spawnImpl };
}

function adapterFor(spawnImpl, overrides = {}) {
  return createCodexAdapter({ defaultMode: "default", log: () => {}, spawnImpl, bin: "codex-test", ...overrides });
}

test("plan mode asks for a read-only sandbox through a config override", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  const turn = adapter.ask({ prompt: "review", cwd: "/work", mode: "plan" });
  await new Promise(queueMicrotask);

  const [{ args, options }] = spawned;
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "-c", 'sandbox_mode="read-only"']);
  assert.equal(args.at(-1), "review");
  assert.equal(options.cwd, "/work", "cwd travels through the spawn options, not a --cd flag");

  spawned[0].emit({ type: "thread.started", thread_id: "t-1" });
  spawned[0].emit({ type: "item.completed", item: { type: "agent_message", text: "looks fine" } });
  spawned[0].finish();
  const result = await turn;
  assert.equal(result.sessionId, "t-1");
  assert.equal(result.text, "looks fine");
});

test("yolo mode bypasses the sandbox outright", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  const turn = adapter.ask({ prompt: "go", cwd: "/work", mode: "yolo" });
  await new Promise(queueMicrotask);
  assert.ok(spawned[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(spawned[0].args.includes("-c"), false, "the bypass flag replaces the sandbox override");
  spawned[0].finish();
  await turn;
});

test("resuming a thread uses only flags `codex exec resume` accepts", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);

  const first = adapter.ask({ prompt: "one", cwd: "/work" });
  await new Promise(queueMicrotask);
  spawned[0].emit({ type: "thread.started", thread_id: "t-9" });
  spawned[0].finish();
  await first;

  const second = adapter.ask({ prompt: "two", cwd: "/work" });
  await new Promise(queueMicrotask);
  const { args } = spawned[1];
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.equal(args.at(-2), "t-9", "the thread id precedes the prompt");
  assert.equal(args.at(-1), "two");
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--cd"), false);
  spawned[1].finish();
  await second;
});

test("free-form options become TOML-quoted config overrides", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  const turn = adapter.ask({ prompt: "go", cwd: "/work", options: { model_reasoning_effort: "high", hide_agent_reasoning: true } });
  await new Promise(queueMicrotask);
  const { args } = spawned[0];
  assert.ok(args.includes('model_reasoning_effort="high"'), "string values keep their TOML quotes");
  assert.ok(args.includes("hide_agent_reasoning=true"), "booleans go through bare");
  spawned[0].finish();
  await turn;
});

test("a non-zero exit reports the codex error rather than an empty answer", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  const turn = adapter.ask({ prompt: "go", cwd: "/work" });
  await new Promise(queueMicrotask);
  spawned[0].emit({ type: "turn.failed", error: { message: "sandbox denied the write" } });
  spawned[0].finish(1);
  await assert.rejects(turn, /codex exec exited 1: sandbox denied the write/);
});

test("a missing binary explains how to fix it", async () => {
  const { spawned, spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  const turn = adapter.ask({ prompt: "go", cwd: "/work" });
  await new Promise(queueMicrotask);
  const error = new Error("spawn failed");
  error.code = "ENOENT";
  spawned[0].proc.emit("error", error);
  await assert.rejects(turn, /Codex CLI not found \(tried "codex-test"\)/);
});

test("cancelling a session with no running turn says why nothing happened", () => {
  const { spawnImpl } = fakeCodex();
  const adapter = adapterFor(spawnImpl);
  assert.throws(() => adapter.cancel("t-unknown"), /No codex turn is currently running/);
});

test("normalizes codex items into observable events without leaking reasoning text", () => {
  assert.deepEqual(normalizeCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "private chain of thought" } }), {
    type: "thought.updated"
  });
  assert.deepEqual(normalizeCodexEvent({ type: "item.completed", item: { type: "command_execution", command: "ls", status: "completed" } }), {
    type: "tool.updated",
    title: "Command: ls",
    status: "completed"
  });
  assert.equal(normalizeCodexEvent({ type: "item.completed" }), null);
});

test("absorbItem records errors instead of throwing them into the stream", () => {
  const out = { text: "", thoughts: "", toolCalls: [] };
  const errors = [];
  absorbItem(out, { type: "error", message: "model refused" }, errors, 1024);
  absorbItem(out, { type: "file_change", changes: [{ path: "a.js" }, { path: "b.js" }] }, errors, 1024);
  assert.deepEqual(errors, ["model refused"]);
  assert.deepEqual(out.toolCalls, [{ title: "Edit: a.js, b.js", status: "completed" }]);
});

test("output beyond the byte cap fails the turn instead of ballooning memory", () => {
  const out = { text: "", thoughts: "", toolCalls: [] };
  assert.throws(() => absorbItem(out, { type: "agent_message", text: "x".repeat(50) }, [], 10), /exceeds the 10-byte limit/);
});
