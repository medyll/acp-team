import { z } from "zod";
import { jsonResult } from "./shared.js";

export function registerUsageTools(server, { registry, usageManager }) {
  const AgentId = z.enum(registry.ids);
  const filters = { period: z.enum(["day", "week", "month"]).optional(), agent: AgentId.optional(), model: z.string().optional() };

  server.registerTool(
    "usage_status",
    {
      title: "Usage and budget status",
      description: "Show observed tokens, reported cost, configured budget, reset period and active promotion. Unknown provider quotas remain explicitly unknown.",
      inputSchema: filters
    },
    async ({ period, agent, model }) => jsonResult(await usageManager.status({ period, agent, model }))
  );

  server.registerTool(
    "usage_report",
    {
      title: "Usage report by model",
      description: "Aggregate the local usage ledger by agent and model for a period.",
      inputSchema: filters
    },
    async ({ period, agent, model }) => jsonResult(await usageManager.report({ period, agent, model }))
  );

  server.registerTool(
    "model_recommend",
    {
      title: "Recommend an admissible model",
      description: "Choose configured cheap, standard or premium model candidates while respecting the local budget policy.",
      inputSchema: { task: z.string().optional(), profile: z.enum(["auto", "cheap", "standard", "premium"]).optional() }
    },
    async ({ task, profile }) => jsonResult(await usageManager.recommend({ task, profile }))
  );

  server.registerTool(
    "budget_check",
    {
      title: "Check a task budget",
      description: "Check an estimated cost against the configured per-run and monthly budget before starting an agent.",
      inputSchema: {
        profile: z.enum(["cheap", "standard", "premium"]).optional(),
        estimated_cost: z.number().nonnegative().optional(),
        currency: z.string().length(3).optional()
      }
    },
    async ({ profile, estimated_cost, currency }) => jsonResult(await usageManager.check({ profile, estimatedCost: estimated_cost, currency }))
  );

  server.registerTool(
    "usage_compact",
    {
      title: "Compact the usage ledger",
      description:
        "Archive ledger entries older than the retention window and fold them into monthly rollups. Reported day, week and month totals are unaffected; this only bounds how much is parsed on every usage call.",
      inputSchema: { force: z.boolean().optional().describe("Compact even when the ledger is below its size limit.") }
    },
    async ({ force }) => jsonResult((await usageManager.compactIfNeeded({ force: force ?? false })) ?? { compacted: false, reason: "ledger is within its size limit" })
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
      return jsonResult(await usageManager.syncOpenRouter({ apiKey }));
    }
  );
}
