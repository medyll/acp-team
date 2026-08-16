import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings, runtimeFromEnvironment } from "./runtime-config.js";

test("normalizes legacy settings without losing their values", () => {
  const settings = normalizeSettings({ schemaVersion: 1, interaction: { language: "en" }, runtime: { maxConcurrentPerAgent: 4 } });
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.interaction.language, "en");
  assert.equal(settings.runtime.maxConcurrentPerAgent, 4);
  assert.equal(settings.runtime.resilience.retryAttempts, 3);
});

test("a settings file cannot reassign a prototype through merge", () => {
  // JSON.parse keeps "__proto__" as an own property, so a hand-edited settings
  // file reaches merge with a key that assignment would treat as the prototype.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"runtime":{"maxConcurrentPerAgent":3}}');
  const settings = normalizeSettings(hostile);

  assert.equal(settings.polluted, undefined);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype, "the settings object keeps a plain prototype");
  assert.equal({}.polluted, undefined, "nothing leaks into Object.prototype");
  assert.equal(settings.runtime.maxConcurrentPerAgent, 3, "legitimate values in the same file still apply");
});

test("environment values override file runtime settings", () => {
  const runtime = runtimeFromEnvironment({ runtime: { enabledAgents: ["ollama"], maxConcurrentPerAgent: 4 } }, {
    AGENT_BRIDGE_AGENTS: "codex,kimi",
    AGENT_BRIDGE_MAX_CONCURRENT: "7",
    CODEX_BRIDGE_MODEL: "gpt-test"
  });
  assert.deepEqual(runtime.enabledAgents, ["codex", "kimi"]);
  assert.equal(runtime.maxConcurrentPerAgent, 7);
  assert.equal(runtime.agents.codex.model, "gpt-test");
});
