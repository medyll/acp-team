import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));

async function withClient(toolsMode, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "cli.js")],
    env: { ...inheritedEnv, ACP_TEAM_TOOLS: toolsMode },
    stderr: "pipe"
  });
  const client = new Client({ name: "acp-team-tools-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("exposes only the core delegation and run controls by default", async () => {
  await withClient("core", async (client) => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), [
      "agent_ask",
      "agent_cancel",
      "agent_fanout",
      "agent_list",
      "agent_start",
      "agent_status",
      "agent_stop",
      "agent_watch",
      "run_history",
      "run_retry",
      "run_show"
    ]);
    const askSchema = response.tools.find((tool) => tool.name === "agent_ask").inputSchema.properties;
    assert.ok(askSchema.authorization);
    assert.equal(askSchema.confirm_write, undefined);
    assert.equal(askSchema.return.default, "summary");

    const listed = await client.callTool({ name: "agent_list", arguments: {} });
    const agents = JSON.parse(listed.content[0].text);
    assert.deepEqual(
      agents.map((agent) => agent.id).sort(),
      ["codex", "kimi", "ollama", "opencode"]
    );
  });
});

test("full mode keeps every administration tool available", async () => {
  await withClient("full", async (client) => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 29);
    assert.ok(names.includes("config_inspect"));
    assert.ok(names.includes("usage_status"));
    assert.ok(names.includes("model_recommend"));
    assert.ok(names.includes("budget_check"));
    assert.ok(names.includes("ollama_models"));
    assert.ok(names.includes("system_doctor"));

    const usage = await client.callTool({ name: "usage_status", arguments: { period: "month" } });
    const status = JSON.parse(usage.content[0].text);
    assert.equal(status.period.kind, "month");
    assert.equal(status.budget.status, "not-configured");
  });
});
