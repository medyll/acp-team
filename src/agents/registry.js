import { createKimiAdapter } from "./kimi/kimi-adapter.js";
import { createCodexAdapter } from "./codex/codex-adapter.js";

/**
 * Builds every adapter the bridge exposes. Adding an agent means adding a
 * folder under src/agents/ and one line here.
 */
export function createRegistry({ log }) {
  const adapters = [
    createKimiAdapter({
      defaultModel: process.env.KIMI_BRIDGE_MODEL,
      defaultMode: process.env.KIMI_BRIDGE_MODE || "auto",
      permissionPolicy: process.env.KIMI_BRIDGE_PERMISSION || "allow",
      log
    }),
    createCodexAdapter({
      defaultModel: process.env.CODEX_BRIDGE_MODEL,
      defaultMode: process.env.CODEX_BRIDGE_MODE || "default",
      log
    })
  ];

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
