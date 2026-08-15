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
import { runtimeFromEnvironment } from "./config/runtime-config.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerUsageTools } from "./tools/usage-tools.js";
import { registerConfigTools } from "./tools/config-tools.js";
import { registerOllamaTools } from "./tools/ollama-tools.js";
import { createAuthorizationManager } from "./security/authorization-manager.js";
import { registerSystemTools } from "./tools/system-tools.js";

const DEFAULT_CWD = process.env.AGENT_BRIDGE_CWD || process.cwd();
const DATA_DIR = process.env.AGENT_BRIDGE_DATA_DIR || path.join(DEFAULT_CWD, ".acp-team");

const log = createLogger({ name: "acp-team" });
const configManager = createConfigManager({ dataDir: DATA_DIR });
const runtimeConfig = runtimeFromEnvironment(await configManager.runtime());
const registry = createRegistry({ log, runtime: runtimeConfig });
const usageManager = createUsageManager({
  dataDir: DATA_DIR,
  timeoutMs: runtimeConfig.resilience.httpTimeoutMs,
  maxResponseBytes: runtimeConfig.resilience.maxResponseBytes,
  retryOptions: { attempts: runtimeConfig.resilience.retryAttempts }
});
const authorizationManager = createAuthorizationManager({ dataDir: DATA_DIR });
const journal = createRunJournal({ dataDir: DATA_DIR, onError: (error) => log.warn("run journal write failed", { error: error.message }) });
await journal.markInterrupted();
const runManager = createRunManager({
  registry,
  usageManager,
  journal,
  maxConcurrentPerAgent: runtimeConfig.maxConcurrentPerAgent
});

const server = new McpServer({ name: "acp-team", version: "1.0.0" });

registerAgentTools(server, { registry, runManager, usageManager, authorizationManager, journal, defaultCwd: DEFAULT_CWD, log });
registerUsageTools(server, { registry, usageManager });
registerConfigTools(server, { configManager });
if (registry.ids.includes("ollama")) registerOllamaTools(server, { registry, log });
registerSystemTools(server, { configManager, registry, dataDir: DATA_DIR });

const shutdown = () => {
  runManager.stopAll();
  registry.stopAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log.info("ready", { cwd: DEFAULT_CWD, agents: registry.ids });
