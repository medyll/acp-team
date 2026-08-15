import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createController, extractJsonObject, parseWith } from "./controller.js";

test("--with selects a model for the default controller", () => {
  assert.deepEqual(parseWith("opus"), { controller: "claude", model: "opus" });
  assert.deepEqual(parseWith("codex:gpt-5"), { controller: "codex", model: "gpt-5" });
  assert.deepEqual(parseWith("kimi"), { controller: "kimi", model: null });
  assert.deepEqual(parseWith("ollama:qwen3-coder"), { controller: "ollama", model: "qwen3-coder" });
});

test("extracts structured controller output", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.deepEqual(extractJsonObject("Here: {\"ok\":true}"), { ok: true });
});

test("kills a stalled Claude controller after its deadline", async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => { killed = true; };
    return child;
  };
  const controller = createController({ spawnImpl, timeoutMs: 5 });
  await assert.rejects(() => controller.prompt("configure"), /timed out/);
  assert.equal(killed, true);
});
