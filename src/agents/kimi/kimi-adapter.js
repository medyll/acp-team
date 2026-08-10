import { createAcpAdapter } from "../acp/acp-adapter.js";
import { KimiAcpClient } from "./kimi-acp-client.js";

export function createKimiAdapter({ permissionPolicy, log, client, ...options } = {}) {
  return createAcpAdapter({
    id: "kimi",
    description: "Kimi Code CLI over ACP. Strong on long-context reasoning; runs its own file and shell tools.",
    permissionPolicy,
    log,
    client: client ?? new KimiAcpClient({ permissionPolicy, onLog: log }),
    ...options
  });
}
