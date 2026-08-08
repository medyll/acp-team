// Direct adapter smoke test: no MCP layer, just the adapter -> `codex exec`.
// Runs two turns to check that thread resume keeps conversation state.
// Usage: node src/agents/codex/codex-smoke-test.js
import { createCodexAdapter } from "./codex-adapter.js";

const codex = createCodexAdapter({ defaultMode: "plan", log: (m) => console.error(m) });
console.log("status:", JSON.stringify(await codex.status(), null, 2));

const first = await codex.ask({ prompt: "Remember the number 4271. Reply with exactly: PONG", cwd: process.cwd() });
console.log("turn 1:", { session: first.sessionId, stop: first.stopReason, text: first.text.trim() });

const second = await codex.ask({ prompt: "What number did I ask you to remember? Reply with digits only.", cwd: process.cwd() });
console.log("turn 2:", { session: second.sessionId, text: second.text.trim() });
console.log(second.text.includes("4271") ? "resume OK" : "resume FAILED");
process.exit(0);
