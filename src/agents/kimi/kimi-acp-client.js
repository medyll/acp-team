import { AcpClient } from "../acp/acp-client.js";

const KIMI_BIN = process.env.KIMI_BIN || (process.platform === "win32" ? "kimi.exe" : "kimi");

export class KimiAcpClient extends AcpClient {
  constructor(options = {}) {
    super({
      command: KIMI_BIN,
      args: ["acp"],
      agentLabel: "Kimi",
      clientName: "kimi-acp-bridge",
      missingHint: "Install it and run `kimi login`, or set KIMI_BIN to its path.",
      ...options
    });
  }
}
