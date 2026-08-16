import { z } from "zod";
import { diagnose } from "../doctor.js";
import { jsonResult } from "./shared.js";

export function registerSystemTools(server, { configManager, registry, dataDir }) {
  const AgentId = z.enum(registry.ids);
  server.registerTool(
    "system_doctor",
    {
      title: "Diagnose ACP Team",
      description: "Check configuration, data-directory access and installed agent health without changing the system.",
      inputSchema: { agent: AgentId.optional() }
    },
    async ({ agent }) => jsonResult(await diagnose({ configManager, registry, dataDir, agent }))
  );
}
