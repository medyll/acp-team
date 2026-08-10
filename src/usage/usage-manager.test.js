import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsageManager } from "./usage-manager.js";

test("records measured usage and reports it for the current month", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  await manager.record({ agent: "codex", model: "gpt-test", runId: "run-1", usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } });
  const status = await manager.status();
  assert.equal(status.totals.runs, 1);
  assert.equal(status.totals.tokens.input, 12);
  assert.equal(status.totals.tokens.total, 17);
  assert.equal(status.budget.status, "not-configured");
  assert.match(await readFile(manager.files.ledger, "utf8"), /agent-reported/);
});

test("recommends a cheap profile without exposing disabled models", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir });
  const recommendation = await manager.recommend({ task: "Simple rename", profile: "auto" });
  assert.equal(recommendation.profile, "cheap");
  assert.deepEqual(recommendation.candidates, ["opencode/default"]);
});

test("applies an active promotion multiplier to a configured monthly budget", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  await manager.ensure();
  await writeFile(manager.files.budgets, JSON.stringify({ currency: "USD", periods: { monthly: 10 }, profiles: {} }));
  await writeFile(manager.files.promotions, JSON.stringify({ promotions: [{ multiplier: 2, expiresAt: "2026-09-01T00:00:00Z" }] }));
  const status = await manager.status();
  assert.equal(status.budget.amount, 20);
  assert.equal(status.budget.configuredAmount, 10);
  assert.equal(status.budget.multiplier, 2);
});

test("synchronizes OpenRouter credits and its model catalog without storing the key", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const calls = [];
  const manager = createUsageManager({
    dataDir,
    now: () => new Date("2026-08-10T12:00:00Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith("credits") ? { data: { total_credits: 10, total_usage: 3 } } : { data: [{ id: "provider/model", name: "Model", context_length: 1000, pricing: { prompt: "0.000001" }, supported_parameters: ["tools"] }] } };
    }
  });
  const synced = await manager.syncOpenRouter({ apiKey: "secret-key" });
  assert.deepEqual(synced.credits, { total: 10, used: 3, remaining: 7, currency: "USD" });
  assert.equal(synced.modelCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-key");
  assert.doesNotMatch(await readFile(manager.files.providers, "utf8"), /secret-key/);
});
