import { createKimiAdapter } from "./kimi/kimi-adapter.js";
import { createCodexAdapter } from "./codex/codex-adapter.js";
import { createOpenCodeAdapter } from "./opencode/opencode-adapter.js";
import { createOllamaAdapter } from "../ollama/ollama-adapter.js";
import { createDeclarativeAdapter, validateAgentDefinition } from "./declarative-adapter.js";
import { runtimeFromEnvironment } from "../config/runtime-config.js";

/**
 * Builds every adapter the bridge exposes. Adding an agent means adding a
 * folder under src/agents/ and one line here.
 */
export function createRegistry({ log, settings, runtime, env = process.env } = {}) {
  runtime ??= runtimeFromEnvironment(settings, env);
  const configured = runtime.agents;
  const resilience = runtime.resilience;
  const builtInIds = ["kimi", "codex", "opencode", "ollama"];
  const builders = {
    kimi: () =>
      createKimiAdapter({
        defaultModel: configured.kimi.model,
        defaultMode: configured.kimi.mode,
        permissionPolicy: configured.kimi.permission,
        clientOptions: { requestTimeoutMs: resilience.agentTimeoutMs },
        log
      }),
    codex: () =>
      createCodexAdapter({
        defaultModel: configured.codex.model,
        defaultMode: configured.codex.mode,
        timeoutMs: resilience.agentTimeoutMs,
        log
      }),
    opencode: () =>
      createOpenCodeAdapter({
        defaultModel: configured.opencode.model,
        defaultMode: configured.opencode.mode,
        permissionPolicy: configured.opencode.permission,
        clientOptions: { requestTimeoutMs: resilience.agentTimeoutMs },
        log
      }),
    ollama: () =>
      createOllamaAdapter({
        defaultModel: configured.ollama.model,
        clientOptions: { timeoutMs: resilience.httpTimeoutMs, maxResponseBytes: resilience.maxResponseBytes },
        log
      })
  };

  for (const definition of runtime.customAgents ?? []) {
    validateAgentDefinition(definition);
    if (builders[definition.id]) throw new Error(`Custom agent id conflicts with built-in agent "${definition.id}"`);
    builders[definition.id] = () => createDeclarativeAdapter(definition, { log, requestTimeoutMs: resilience.agentTimeoutMs });
  }

  // Installing every CLI is optional: AGENT_BRIDGE_AGENTS narrows the roster so a
  // host only ever sees agents that can actually answer.
  const requested = runtime.enabledAgents ?? builtInIds;
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
