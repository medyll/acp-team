import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaAdapter } from "./ollama-adapter.js";

test("keeps Ollama conversations per working directory", async () => {
  const requests = [];
  const client = {
    host: "http://local",
    list: async () => ({ models: [{ model: "qwen" }] }),
    chat: async (request) => {
      requests.push(structuredClone(request.messages));
      return { message: { content: `answer ${requests.length}` }, done_reason: "stop", prompt_eval_count: 2, eval_count: 3 };
    }
  };
  const adapter = createOllamaAdapter({ client, defaultModel: "qwen" });
  const first = await adapter.ask({ prompt: "one", cwd: "/project" });
  const second = await adapter.ask({ prompt: "two", cwd: "/project" });
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(requests[1].map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(second.usage.totalTokens, 5);
});

test("does not mistake an embedding model for a chat default", async () => {
  const adapter = createOllamaAdapter({ client: { list: async () => ({ models: [{ model: "nomic-embed-text" }, { model: "qwen" }] }) } });
  await assert.rejects(() => adapter.ask({ prompt: "hello", cwd: "/project" }), /Choose an Ollama model.*nomic-embed-text.*qwen/);
});
