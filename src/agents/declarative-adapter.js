import { AcpClient } from "./acp/acp-client.js";
import { createAcpAdapter } from "./acp/acp-adapter.js";
import { assertSupportedMode } from "./agent.js";

export function validateAgentDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new Error("Custom agent definition must be an object");
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(definition.id ?? "")) throw new Error("Custom agent id must use 2-32 lowercase letters, numbers, _ or -");
  if (definition.transport !== "acp") throw new Error(`Custom agent ${definition.id} must use the acp transport`);
  if (typeof definition.command !== "string" || !definition.command.trim() || /[\r\n;&|><`]/.test(definition.command)) {
    throw new Error(`Custom agent ${definition.id} has an unsafe command`);
  }
  if (!Array.isArray(definition.args ?? []) || (definition.args ?? []).some((arg) => typeof arg !== "string" || /[\r\n;&|><`]/.test(arg))) {
    throw new Error(`Custom agent ${definition.id} has unsafe arguments`);
  }
  assertSupportedMode(definition.mode ?? "plan");
  if (definition.permission && !["allow", "deny"].includes(definition.permission)) throw new Error(`Custom agent ${definition.id} has an invalid permission policy`);
  return definition;
}

export function createDeclarativeAdapter(definition, { log, requestTimeoutMs } = {}) {
  validateAgentDefinition(definition);
  const client = new AcpClient({
    command: definition.command,
    displayCommand: definition.command,
    args: definition.args ?? ["acp"],
    shell: false,
    agentLabel: definition.name ?? definition.id,
    permissionPolicy: definition.permission ?? "deny",
    requestTimeoutMs,
    onLog: log
  });
  return createAcpAdapter({
    id: definition.id,
    description: definition.description ?? `Declarative ACP agent ${definition.id}`,
    client,
    defaultModel: definition.model,
    defaultMode: definition.mode ?? "plan",
    permissionPolicy: definition.permission ?? "deny",
    log
  });
}
