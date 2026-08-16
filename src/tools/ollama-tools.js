import { z } from "zod";
import { jsonResult, progressReporter } from "./shared.js";

/** Only registered when Ollama is part of the enabled roster. */
export function registerOllamaTools(server, { registry, log }) {
  const ollama = () => registry.get("ollama");

  server.registerTool(
    "ollama_status",
    {
      title: "Ollama status",
      description: "Check the configured Ollama endpoint, version, available models and models currently loaded in memory.",
      inputSchema: {}
    },
    async () => jsonResult(await ollama().status())
  );

  server.registerTool(
    "ollama_models",
    {
      title: "List Ollama models",
      description: "List models available through the configured local or cloud Ollama API.",
      inputSchema: {}
    },
    async () => jsonResult(await ollama().client.list())
  );

  server.registerTool(
    "ollama_model_show",
    {
      title: "Inspect an Ollama model",
      description: "Show model metadata and capabilities without returning large verbose template fields.",
      inputSchema: { model: z.string().min(1) }
    },
    async ({ model }) => jsonResult(await ollama().client.show({ model }))
  );

  server.registerTool(
    "ollama_running",
    {
      title: "List running Ollama models",
      description: "List models currently loaded into memory, including context and VRAM information when reported by Ollama.",
      inputSchema: {}
    },
    async () => jsonResult(await ollama().client.ps())
  );

  server.registerTool(
    "ollama_pull",
    {
      title: "Pull an Ollama model",
      description: "Download an Ollama model. This can consume substantial bandwidth and disk space; call only after explicit user confirmation.",
      inputSchema: { model: z.string().min(1), confirm: z.literal("pull") }
    },
    async ({ model }, extra) => {
      const report = progressReporter(extra, log);
      report({ type: "ollama.pull", title: model, status: "started" });
      const result = await ollama().client.pull({ model, signal: extra?.signal });
      report({ type: "ollama.pull", title: model, status: "completed" });
      return jsonResult(result);
    }
  );
}
