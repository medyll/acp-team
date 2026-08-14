import { createKimiAdapter } from "./kimi/kimi-adapter.js";
import { createCodexAdapter } from "./codex/codex-adapter.js";
import { createOpenCodeAdapter } from "./opencode/opencode-adapter.js";
import { createOllamaAdapter } from "../ollama/ollama-adapter.js";

/**
 * Builds every adapter the bridge exposes. Adding an agent means adding a
 * folder under src/agents/ and one line here.
 */
export function createRegistry({ log }) {
  const builders = {
    kimi: () =>
      createKimiAdapter({
        defaultModel: process.env.KIMI_BRIDGE_MODEL,
        defaultMode: process.env.KIMI_BRIDGE_MODE || "auto",
        permissionPolicy: process.env.KIMI_BRIDGE_PERMISSION || "allow",
        log
      }),
    codex: () =>
      createCodexAdapter({
        defaultModel: process.env.CODEX_BRIDGE_MODEL,
        defaultMode: process.env.CODEX_BRIDGE_MODE || "default",
        log
      }),
    opencode: () =>
      createOpenCodeAdapter({
        defaultModel: process.env.OPENCODE_BRIDGE_MODEL,
        defaultMode: process.env.OPENCODE_BRIDGE_MODE || "default",
        permissionPolicy: process.env.OPENCODE_BRIDGE_PERMISSION || "allow",
        log
      }),
    ollama: () =>
      createOllamaAdapter({
        defaultModel: process.env.OLLAMA_BRIDGE_MODEL,
        log
      })
  };

  // Installing every CLI is optional: AGENT_BRIDGE_AGENTS narrows the roster so a
  // host only ever sees agents that can actually answer.
  const requested = (process.env.AGENT_BRIDGE_AGENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((id) => !builders[id]);
  if (unknown.length) {
    throw new Error(
      `AGENT_BRIDGE_AGENTS lists unknown agent(s): ${unknown.join(", ")}. Known: ${Object.keys(builders).join(", ")}`
    );
  }
  const enabled = requested.length ? requested : Object.keys(builders);
  const adapters = enabled.map((id) => builders[id]());

  const byId = new Map(adapters.map((a) => [a.id, a]));

  return {
    ids: adapters.map((a) => a.id),
    list: () => adapters,
    get(id) {
      const adapter = byId.get(id);
      if (!adapter) throw new Error(`Unknown agent "${id}". Available: ${[...byId.keys()].join(", ")}`);
      return adapter;
    },
    stopAll() {
      for (const a of adapters) a.stop?.();
    }
  };
}
