#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRegistry } from "./agents/registry.js";
import { MODES } from "./agents/agent.js";
import { createRunManager } from "./runs/run-manager.js";
import { createUsageManager } from "./usage/usage-manager.js";
import path from "node:path";

const DEFAULT_CWD = process.env.AGENT_BRIDGE_CWD || process.cwd();

const log = (m) => process.stderr.write(`[agent-bridge] ${m}\n`);
const registry = createRegistry({ log });
const usageManager = createUsageManager({ dataDir: process.env.AGENT_BRIDGE_DATA_DIR || path.join(DEFAULT_CWD, ".acp-team") });
const runManager = createRunManager({ registry, usageManager });

const AgentId = z.enum(registry.ids);

function render({ agent, result, includeThoughts }) {
  const body = result.text.trim() || `(${agent} returned no text)`;
  const tools = result.toolCalls.length
    ? `\n\n---\n${agent} tool calls:\n${result.toolCalls.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
    : "";
  const thoughts = includeThoughts && result.thoughts ? `\n\n---\n${agent} thoughts:\n${result.thoughts}` : "";
  return `${body}${tools}${thoughts}\n\n(agent: ${agent}, session: ${result.sessionId}, stop: ${result.stopReason})`;
}

function progressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  let progress = 0;
  return (event) => {
    if (progressToken === undefined) return;
    const message = [event.type, event.title, event.status].filter(Boolean).join(" — ");
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message }
      })
      .catch((error) => log(`progress notification failed: ${error.message}`));
  };
}

const server = new McpServer({ name: "acp-team", version: "1.0.0" });

server.registerTool(
  "agent_ask",
  {
    title: "Ask a teammate agent",
    description:
      "Delegate a task to another coding agent (kimi, codex or opencode). The agent runs its own tools — file reads/writes, shell — inside the given working directory, and returns its final answer plus a summary of what it ran. Conversation state is kept per agent per working directory unless session_id or new_session is given.",
    inputSchema: {
      agent: AgentId.describe("Which agent to delegate to."),
      prompt: z.string().describe("Instruction or question to send."),
      cwd: z.string().optional().describe("Working directory the agent operates in. Defaults to the bridge cwd."),
      session_id: z.string().optional().describe("Existing session/thread to continue."),
      new_session: z.boolean().optional().describe("Force a fresh session instead of reusing the one for this cwd."),
      model: z.string().optional().describe("Model override supported by the selected agent."),
      mode: z.enum(MODES).optional().describe("Permission/sandbox mode: plan is read-only, yolo removes all guardrails."),
      thinking: z.enum(["low", "high", "max", "on"]).optional().describe("Reasoning effort (kimi only)."),
      options: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          'Free-form model/agent settings. For codex these become `-c key=value` overrides; ACP agents apply them as session config options. Invalid keys or values are reported by the agent.'
        ),
      include_thoughts: z.boolean().optional().describe("Include the agent's reasoning stream in the output.")
    }
  },
  async ({ agent, prompt, cwd, session_id, new_session, model, mode, thinking, options, include_thoughts }, extra) => {
    const adapter = registry.get(agent);
    const result = await adapter.ask({
      prompt,
      cwd: cwd || DEFAULT_CWD,
      sessionId: session_id,
      newSession: new_session,
      model,
      mode,
      thinking,
      options,
      signal: extra?.signal,
      onEvent: progressReporter(extra)
    });
    await usageManager.record({ agent, model, sessionId: result.sessionId, usage: result.usage, cost: result.cost });
    return { content: [{ type: "text", text: render({ agent, result, includeThoughts: include_thoughts }) }] };
  }
);

server.registerTool(
  "agent_start",
  {
    title: "Start a supervised agent run",
    description:
      "Start an agent turn in the background and return a run_id immediately. Use agent_watch to observe it and agent_stop to interrupt it.",
    inputSchema: {
      agent: AgentId.describe("Which agent to delegate to."),
      prompt: z.string().describe("Instruction or question to send."),
      cwd: z.string().optional().describe("Working directory. Defaults to the bridge cwd."),
      session_id: z.string().optional().describe("Existing session/thread to continue."),
      new_session: z.boolean().optional().describe("Force a fresh session."),
      model: z.string().optional().describe("Model override."),
      mode: z.enum(MODES).optional().describe("Permission/sandbox mode."),
      thinking: z.enum(["low", "high", "max", "on"]).optional().describe("Reasoning effort (kimi only)."),
      options: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
    }
  },
  async ({ agent, prompt, cwd, session_id, new_session, model, mode, thinking, options }) => {
    const run = runManager.start({
      agent,
      prompt,
      cwd: cwd || DEFAULT_CWD,
      sessionId: session_id,
      newSession: new_session,
      model,
      mode,
      thinking,
      options
    });
    return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] };
  }
);

server.registerTool(
  "agent_watch",
  {
    title: "Watch a supervised agent run",
    description:
      "Return a run's state and events. Pass after_event to receive only newer events; wait_ms enables bounded long-polling.",
    inputSchema: {
      run_id: z.string(),
      after_event: z.number().int().nonnegative().optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional()
    }
  },
  async ({ run_id, after_event, wait_ms }) => {
    const run = await runManager.watch(run_id, { afterEvent: after_event ?? 0, waitMs: wait_ms ?? 0 });
    return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] };
  }
);

server.registerTool(
  "agent_stop",
  {
    title: "Stop a supervised agent run",
    description: "Interrupt a queued or running delegation by run_id, even before the agent has exposed a session id.",
    inputSchema: { run_id: z.string() }
  },
  async ({ run_id }) => {
    const run = runManager.stop(run_id);
    return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] };
  }
);

server.registerTool(
  "usage_status",
  {
    title: "Usage and budget status",
    description: "Show observed tokens, reported cost, configured budget, reset period and active promotion. Unknown provider quotas remain explicitly unknown.",
    inputSchema: { period: z.enum(["day", "week", "month"]).optional(), agent: AgentId.optional(), model: z.string().optional() }
  },
  async ({ period, agent, model }) => ({ content: [{ type: "text", text: JSON.stringify(await usageManager.status({ period, agent, model }), null, 2) }] })
);

server.registerTool(
  "usage_report",
  {
    title: "Usage report by model",
    description: "Aggregate the local usage ledger by agent and model for a period.",
    inputSchema: { period: z.enum(["day", "week", "month"]).optional(), agent: AgentId.optional(), model: z.string().optional() }
  },
  async ({ period, agent, model }) => ({ content: [{ type: "text", text: JSON.stringify(await usageManager.report({ period, agent, model }), null, 2) }] })
);

server.registerTool(
  "model_recommend",
  {
    title: "Recommend an admissible model",
    description: "Choose configured cheap, standard or premium model candidates while respecting the local budget policy.",
    inputSchema: { task: z.string().optional(), profile: z.enum(["auto", "cheap", "standard", "premium"]).optional() }
  },
  async ({ task, profile }) => ({ content: [{ type: "text", text: JSON.stringify(await usageManager.recommend({ task, profile }), null, 2) }] })
);

server.registerTool(
  "budget_check",
  {
    title: "Check a task budget",
    description: "Check an estimated cost against the configured per-run and monthly budget before starting an agent.",
    inputSchema: { profile: z.enum(["cheap", "standard", "premium"]).optional(), estimated_cost: z.number().nonnegative().optional(), currency: z.string().length(3).optional() }
  },
  async ({ profile, estimated_cost, currency }) => ({ content: [{ type: "text", text: JSON.stringify(await usageManager.check({ profile, estimatedCost: estimated_cost, currency }), null, 2) }] })
);

server.registerTool(
  "usage_sync",
  {
    title: "Synchronize provider usage",
    description: "Refresh OpenRouter credits and its model-price catalog. Requires OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_API_KEY); the key is never written to disk.",
    inputSchema: { provider: z.literal("openrouter").optional() }
  },
  async () => {
    const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_API_KEY;
    return { content: [{ type: "text", text: JSON.stringify(await usageManager.syncOpenRouter({ apiKey }), null, 2) }] };
  }
);

server.registerTool(
  "agent_list",
  {
    title: "List teammate agents",
    description: "List the agents this bridge can delegate to, with what each one is good for and which modes it accepts.",
    inputSchema: {}
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          registry.list().map((a) => ({ id: a.id, description: a.description, modes: a.modes })),
          null,
          2
        )
      }
    ]
  })
);

server.registerTool(
  "agent_status",
  {
    title: "Agent status",
    description: "Show transport, version, available models, defaults and open sessions — for one agent or all of them.",
    inputSchema: { agent: AgentId.optional().describe("Omit to report on every agent.") }
  },
  async ({ agent }) => {
    const targets = agent ? [registry.get(agent)] : registry.list();
    const report = {};
    for (const a of targets) {
      try {
        report[a.id] = await a.status();
      } catch (e) {
        report[a.id] = { error: e.message };
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ bridgeCwd: DEFAULT_CWD, agents: report, runs: runManager.list({ agent }) }, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "agent_cancel",
  {
    title: "Cancel an agent turn",
    description: "Cancel the current turn of a session. Only agents with long-running sessions support this.",
    inputSchema: { agent: AgentId, session_id: z.string() }
  },
  async ({ agent, session_id }) => {
    registry.get(agent).cancel(session_id);
    return { content: [{ type: "text", text: `Cancel sent to ${agent} session ${session_id}` }] };
  }
);

const shutdown = () => {
  runManager.stopAll();
  registry.stopAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log(`ready (cwd=${DEFAULT_CWD}, agents=${registry.ids.join(", ")})`);
