import { createAcpAdapter } from "../acp/acp-adapter.js";
import { OpenCodeAcpClient } from "./opencode-acp-client.js";

function mapOpenCodeMode(mode) {
  if (!mode) return mode;
  return mode === "plan" ? "plan" : "build";
}

export function createOpenCodeAdapter({ permissionPolicy, log, client, createClient, clientOptions, ...options } = {}) {
  return createAcpAdapter({
    id: "opencode",
    description: "OpenCode CLI over ACP. Provider-agnostic coding agent with native tools and session continuity.",
    permissionPolicy,
    log,
    mapMode: mapOpenCodeMode,
    client,
    createClient:
      client ? undefined : createClient ?? ((cwd) => new OpenCodeAcpClient({ permissionPolicy, onLog: log, cwd, ...clientOptions })),
    ...options
  });
}

