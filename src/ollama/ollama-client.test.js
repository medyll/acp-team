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

test("times out stalled calls and caps response bodies", async () => {
  const stalled = createOllamaClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(() => stalled.list(), /timed out/);
  } finally {
    clearInterval(keepAlive);
  }

  const oversized = createOllamaClient({ maxResponseBytes: 16, fetchImpl: async () => new Response(JSON.stringify({ value: "x".repeat(100) })) });
  await assert.rejects(() => oversized.list(), /exceeds/);
});

test("refuses to send an API key over remote plain HTTP", () => {
  assert.throws(() => createOllamaClient({ host: "http://ollama.example", apiKey: "secret" }), /requires HTTPS/);
});
