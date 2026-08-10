import { AcpClient } from "../acp/acp-client.js";

const OPENCODE_BIN =
  process.env.OPENCODE_BIN || (process.platform === "win32" ? "opencode.cmd" : "opencode");
const IS_WINDOWS_SHIM = process.platform === "win32" && /\.(cmd|bat)$/i.test(OPENCODE_BIN);

export class OpenCodeAcpClient extends AcpClient {
  constructor(options = {}) {
    super({
      command: IS_WINDOWS_SHIM ? process.env.ComSpec || "cmd.exe" : OPENCODE_BIN,
      displayCommand: OPENCODE_BIN,
      args: IS_WINDOWS_SHIM ? ["/d", "/s", "/c", `${OPENCODE_BIN} acp`] : ["acp"],
      agentLabel: "OpenCode",
      clientName: "opencode-acp-bridge",
      missingHint: "Install OpenCode and configure a provider, or set OPENCODE_BIN to its path.",
      ...options
    });
  }
}
