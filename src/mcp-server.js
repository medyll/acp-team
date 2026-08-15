#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { createRegistry } from "./agents/registry.js";
import { createLogger } from "./logger.js";
import { createRunManager } from "./runs/run-manager.js";
import { createRunJournal } from "./runs/run-journal.js";
import { createUsageManager } from "./usage/usage-manager.js";
import { createConfigManager } from "./config/config-manager.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerUsageTools } from "./tools/usage-tools.js";
import { registerConfigTools } from "./tools/config-tools.js";
import { registerOllamaTools } from "./tools/ollama-tools.js";

const DEFAULT_CWD = process.env.AGENT_BRIDGE_CWD || process.cwd();
const DATA_DIR = process.env.AGENT_BRIDGE_DATA_DIR || path.join(DEFAULT_CWD, ".acp-team");

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const log = createLogger({ name: "acp-team" });
const registry = createRegistry({ log });
const usageManager = createUsageManager({ dataDir: DATA_DIR });
const configManager = createConfigManager({ dataDir: DATA_DIR });
const journal = createRunJournal({ dataDir: DATA_DIR, onError: (error) => log.warn("run journal write failed", { error: error.message }) });
const runManager = createRunManager({
  registry,
  usageManager,
  journal,
  maxConcurrentPerAgent: positiveInt(process.env.AGENT_BRIDGE_MAX_CONCURRENT, 2)
});

const server = new McpServer({ name: "acp-team", version: "1.0.0" });

registerAgentTools(server, { registry, runManager, usageManager, defaultCwd: DEFAULT_CWD, log });
registerUsageTools(server, { registry, usageManager });
registerConfigTools(server, { configManager });
if (registry.ids.includes("ollama")) registerOllamaTools(server, { registry, log });

const shutdown = () => {
  runManager.stopAll();
  registry.stopAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log.info("ready", { cwd: DEFAULT_CWD, agents: registry.ids });
