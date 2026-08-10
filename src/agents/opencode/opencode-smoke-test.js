// Direct ACP smoke test: OpenCode process, session creation and one prompt.
// Usage: node src/agents/opencode/opencode-smoke-test.js "your prompt"
import { OpenCodeAcpClient } from "./opencode-acp-client.js";

const prompt = process.argv[2] || "Reply with exactly: PONG";
const opencode = new OpenCodeAcpClient({ onLog: (message) => console.error(message) });

try {
  const init = await opencode.start();
  console.log("agent:", init.agentInfo, "protocol:", init.protocolVersion);

  const session = await opencode.newSession({ cwd: process.cwd() });
  console.log("session:", session.sessionId);
  console.log("modes:", session.modes ?? session.availableModes);
  console.log("config:", session.configOptions?.map((option) => option.id));

  const result = await opencode.prompt(session.sessionId, prompt);
  console.log("stopReason:", result.stopReason);
  console.log("tools:", result.toolCalls.map((tool) => `${tool.title ?? tool.kind}:${tool.status}`));
  console.log("text:", result.text.trim());
} finally {
  opencode.stop();
}

