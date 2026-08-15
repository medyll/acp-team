import { z } from "zod";
import { jsonResult } from "./shared.js";

export function registerConfigTools(server, { configManager }) {
  server.registerTool(
    "config_inspect",
    {
      title: "Inspect ACP Team configuration",
      description: "Read the effective ACP Team settings, budgets, model profiles, provider metadata, promotions and model catalog before proposing a change.",
      inputSchema: {}
    },
    async () => jsonResult(await configManager.inspect())
  );

  server.registerTool(
    "config_stage",
    {
      title: "Stage a configuration proposal",
      description: "Validate and save a configuration proposal without applying it. Secrets, tokens and API keys are refused.",
      inputSchema: {
        summary: z.string(),
        rationale: z.array(z.string()).optional(),
        changes: z.array(
          z.object({
            file: z.enum(["settings", "budgets", "models", "providers", "promotions", "catalog"]),
            path: z.string(),
            value: z.unknown(),
            reason: z.string().optional()
          })
        ),
        warnings: z.array(z.string()).optional(),
        sources: z.array(z.object({ url: z.string().url(), title: z.string().optional(), retrievedAt: z.string().optional() })).optional()
      }
    },
    async (proposal) => jsonResult(await configManager.stage(proposal))
  );

  server.registerTool(
    "config_apply",
    {
      title: "Apply a staged configuration proposal",
      description: "Apply a staged proposal and create a rollback snapshot. Call only after the user explicitly approves the displayed proposal.",
      inputSchema: { proposal_id: z.string(), confirm: z.literal("apply") }
    },
    async ({ proposal_id }) => jsonResult(await configManager.apply(proposal_id))
  );

  server.registerTool(
    "config_rollback",
    {
      title: "Rollback ACP Team configuration",
      description: "Restore a configuration backup. Call only after explicit user confirmation.",
      inputSchema: { backup_id: z.string(), confirm: z.literal("rollback") }
    },
    async ({ backup_id }) => jsonResult(await configManager.rollback(backup_id))
  );
}
