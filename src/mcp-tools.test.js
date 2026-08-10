import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("exposes supervised run controls without starting an agent", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "mcp-server.js")],
    stderr: "pipe"
  });
  const client = new Client({ name: "acp-team-tools-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), [
      "agent_ask",
      "agent_cancel",
      "agent_list",
      "agent_start",
      "agent_status",
      "agent_stop",
      "agent_watch",
      "budget_check",
      "model_recommend",
      "usage_report",
      "usage_status",
      "usage_sync"
    ]);

    const listed = await client.callTool({ name: "agent_list", arguments: {} });
    const agents = JSON.parse(listed.content[0].text);
    assert.deepEqual(
      agents.map((agent) => agent.id).sort(),
      ["codex", "kimi", "opencode"]
    );

    const usage = await client.callTool({ name: "usage_status", arguments: { period: "month" } });
    const status = JSON.parse(usage.content[0].text);
    assert.equal(status.period.kind, "month");
    assert.equal(status.budget.status, "not-configured");
  } finally {
    await client.close();
  }
});
