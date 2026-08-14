import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaClient } from "./ollama-client.js";

test("uses Ollama's native API without persisting its key", async () => {
  const calls = [];
  const client = createOllamaClient({
    host: "https://ollama.example/api",
    apiKey: "secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ message: { content: "hello" }, done: true }), { status: 200 });
    }
  });
  const response = await client.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.message.content, "hello");
  assert.equal(calls[0].url, "https://ollama.example/api/chat");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0].options.body).stream, false);
});

test("reports unreachable Ollama hosts clearly", async () => {
  const client = createOllamaClient({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(() => client.list(), /Cannot reach Ollama/);
});
