// Direct ACP smoke test: no MCP layer, no adapter, just the ACP client -> `kimi acp`.
// Usage: node src/agents/kimi/kimi-smoke-test.js "your prompt"
import { KimiAcpClient } from "./kimi-acp-client.js";

const prompt = process.argv[2] || "Reply with exactly: PONG";
const kimi = new KimiAcpClient({ onLog: (m) => console.error(m) });

const init = await kimi.start();
console.log("agent:", init.agentInfo, "protocol:", init.protocolVersion);

const { sessionId, configOptions } = await kimi.newSession({ cwd: process.cwd(), mode: "auto" });
console.log("session:", sessionId);
console.log("models:", configOptions?.find((o) => o.id === "model")?.options?.map((o) => o.value));

const res = await kimi.prompt(sessionId, prompt);
console.log("stopReason:", res.stopReason);
console.log("tools:", res.toolCalls.map((t) => `${t.title ?? t.kind}:${t.status}`));
console.log("text:", res.text.trim());

kimi.stop();
process.exit(0);
