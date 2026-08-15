import assert from "node:assert/strict";
import test from "node:test";
import { MODES, toolSummary } from "./agent.js";
import { createRegistry } from "./registry.js";

/** AGENT_BRIDGE_AGENTS is process-wide, so each case restores what it changed. */
function withRoster(value, body) {
  const previous = process.env.AGENT_BRIDGE_AGENTS;
  if (value === undefined) delete process.env.AGENT_BRIDGE_AGENTS;
  else process.env.AGENT_BRIDGE_AGENTS = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_AGENTS;
    else process.env.AGENT_BRIDGE_AGENTS = previous;
  }
}

const log = () => {};

test("builds every known agent when no roster is configured", () => {
  withRoster(undefined, () => {
    const registry = createRegistry({ log });
    assert.deepEqual(registry.ids.sort(), ["codex", "kimi", "ollama", "opencode"]);
    assert.equal(registry.list().length, 4);
  });
});

test("narrows the roster so a host only sees agents it can actually reach", () => {
  withRoster(" codex , ollama ", () => {
    const registry = createRegistry({ log });
    assert.deepEqual(registry.ids, ["codex", "ollama"]);
    assert.throws(() => registry.get("kimi"), /Unknown agent "kimi"\. Available: codex, ollama/);
  });
});

test("an unknown roster entry fails loudly at startup, not on first delegation", () => {
  withRoster("codex,gpt5", () => {
    assert.throws(() => createRegistry({ log }), /unknown agent\(s\): gpt5\. Known: kimi, codex, opencode, ollama/);
  });
});

test("every adapter honours the shared contract", () => {
  withRoster(undefined, () => {
    for (const adapter of createRegistry({ log }).list()) {
      assert.equal(typeof adapter.id, "string", `${adapter.id} needs an id`);
      assert.ok(adapter.description, `${adapter.id} needs a description`);
      assert.ok(Array.isArray(adapter.modes) && adapter.modes.length, `${adapter.id} must declare its modes`);
      assert.deepEqual(
        adapter.modes.filter((mode) => !MODES.includes(mode)),
        [],
        `${adapter.id} declares a mode outside the shared vocabulary`
      );
      for (const method of ["status", "ask", "cancel"]) {
        assert.equal(typeof adapter[method], "function", `${adapter.id} must implement ${method}()`);
      }
    }
  });
});

test("stopAll tolerates adapters that own nothing to stop", () => {
  withRoster(undefined, () => {
    assert.doesNotThrow(() => createRegistry({ log }).stopAll());
  });
});

test("toolSummary keeps an unknown tool visible rather than dropping it", () => {
  assert.deepEqual(toolSummary(), { title: "(untitled)", status: "unknown" });
  assert.deepEqual(toolSummary("Read files", "completed"), { title: "Read files", status: "completed" });
});
