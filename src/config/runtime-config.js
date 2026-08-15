export const SETTINGS_DEFAULTS = {
  schemaVersion: 2,
  controller: { default: "claude", model: null },
  interaction: { language: "fr", confirmWrites: true },
  discovery: { requireOfficialSources: true, maxAgeDays: 30 },
  runtime: {
    enabledAgents: null,
    maxConcurrentPerAgent: 2,
    resilience: { httpTimeoutMs: 15_000, agentTimeoutMs: 600_000, maxResponseBytes: 16 * 1024 * 1024, retryAttempts: 3 },
    agents: {
      kimi: { model: null, mode: "auto", permission: "allow" },
      codex: { model: null, mode: "default" },
      opencode: { model: null, mode: "default", permission: "allow" },
      ollama: { model: null }
    },
    customAgents: []
  }
};

export function normalizeSettings(settings = {}) {
  const normalized = merge(SETTINGS_DEFAULTS, settings);
  normalized.schemaVersion = SETTINGS_DEFAULTS.schemaVersion;
  return normalized;
}

export function runtimeFromEnvironment(settings, env = process.env) {
  const normalized = normalizeSettings(settings);
  validateRuntimeSettings(normalized);
  const configured = normalized.runtime;
  const enabledAgents = env.AGENT_BRIDGE_AGENTS
    ? splitList(env.AGENT_BRIDGE_AGENTS)
    : Array.isArray(configured.enabledAgents) ? configured.enabledAgents : null;
  return {
    ...configured,
    enabledAgents,
    maxConcurrentPerAgent: positiveInt(env.AGENT_BRIDGE_MAX_CONCURRENT, configured.maxConcurrentPerAgent),
    agents: {
      ...configured.agents,
      kimi: overrideAgent(configured.agents.kimi, env.KIMI_BRIDGE_MODEL, env.KIMI_BRIDGE_MODE, env.KIMI_BRIDGE_PERMISSION),
      codex: overrideAgent(configured.agents.codex, env.CODEX_BRIDGE_MODEL, env.CODEX_BRIDGE_MODE),
      opencode: overrideAgent(configured.agents.opencode, env.OPENCODE_BRIDGE_MODEL, env.OPENCODE_BRIDGE_MODE, env.OPENCODE_BRIDGE_PERMISSION),
      ollama: overrideAgent(configured.agents.ollama, env.OLLAMA_BRIDGE_MODEL)
    }
  };
}

export function validateRuntimeSettings(settings) {
  const runtime = settings?.runtime;
  if (!runtime || typeof runtime !== "object") throw new Error("settings.runtime must be an object");
  if (runtime.enabledAgents !== null && (!Array.isArray(runtime.enabledAgents) || runtime.enabledAgents.some((id) => typeof id !== "string"))) {
    throw new Error("runtime.enabledAgents must be null or an array of agent ids");
  }
  if (!Number.isInteger(runtime.maxConcurrentPerAgent) || runtime.maxConcurrentPerAgent < 1 || runtime.maxConcurrentPerAgent > 100) {
    throw new Error("runtime.maxConcurrentPerAgent must be between 1 and 100");
  }
  for (const [key, value] of Object.entries(runtime.resilience ?? {})) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`runtime.resilience.${key} must be a positive integer`);
  }
  if (!Array.isArray(runtime.customAgents)) throw new Error("runtime.customAgents must be an array");
  return settings;
}

function overrideAgent(current = {}, model, mode, permission) {
  return {
    ...current,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(permission ? { permission } : {})
  };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function merge(base, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, next] of Object.entries(value)) {
    if (next && typeof next === "object" && !Array.isArray(next) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = merge(result[key], next);
    } else {
      result[key] = structuredClone(next);
    }
  }
  return result;
}
