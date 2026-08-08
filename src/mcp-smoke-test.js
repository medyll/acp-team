// End-to-end test through the MCP layer: MCP client -> bridge -> each agent.
// Usage: node src/mcp-smoke-test.js [agent ...]   (default: kimi codex)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["kimi", "codex"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "mcp-server.js")],
  env: { ...process.env, AGENT_BRIDGE_CWD: projectRoot },
  stderr: "inherit"
});
const client = new Client({ name: "acp-team-smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name));

const list = await client.callTool({ name: "agent_list", arguments: {} });
console.log("agents:", list.content[0].text);

let failed = 0;
for (const agent of agents) {
  try {
    const res = await client.callTool(
      {
        name: "agent_ask",
        arguments: { agent, prompt: "Reply with exactly: BRIDGE-OK", mode: "plan" }
      },
      undefined,
      // Agents cold-start slowly; well past the 60s SDK default.
      { timeout: 300_000 }
    );
    const text = res.content[0].text;
    const ok = text.includes("BRIDGE-OK");
    if (!ok) failed++;
    console.log(`\n--- ${agent} ${ok ? "PASS" : "FAIL"} ---\n${text}`);
  } catch (e) {
    failed++;
    console.log(`\n--- ${agent} FAIL ---\n${e.message}`);
  }
}

await client.close();
console.log(failed ? `\n${failed} agent(s) failed` : "\nall agents OK");
process.exit(failed ? 1 : 0);
