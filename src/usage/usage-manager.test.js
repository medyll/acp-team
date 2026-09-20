import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsageManager } from "./usage-manager.js";
import { JevRoutingError } from "./jev-routing-adapter.js";

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

test("derives a token total when the agent reports only the parts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  // Codex and Kimi report input/output and no total; a zero total next to a
  // six-figure input reads as "nothing happened".
  await manager.record({ agent: "codex", model: "gpt-test", runId: "run-1", usage: { input_tokens: 368124, output_tokens: 3686 } });
  const status = await manager.status();
  assert.equal(status.totals.tokens.total, 371810);
});

test("a total the agent does report wins over the derived one", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  await manager.record({ agent: "ollama", model: "local", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 99 } });
  const status = await manager.status();
  assert.equal(status.totals.tokens.total, 99);
});

test("compacts stale ledger entries into rollups without changing reported totals", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const clock = { value: new Date("2026-01-01T12:00:00Z") };
  const manager = createUsageManager({ dataDir, now: () => clock.value, ledgerRetentionDays: 30 });
  await manager.record({ agent: "codex", model: "old", usage: { total_tokens: 100 } });

  clock.value = new Date("2026-08-10T12:00:00Z");
  await manager.record({ agent: "codex", model: "recent", usage: { total_tokens: 7 } });
  const before = await manager.status({ period: "month" });

  const result = await manager.compactIfNeeded({ force: true });
  assert.deepEqual(result, { compacted: true, archived: 1, retained: 1 });

  const after = await manager.status({ period: "month" });
  assert.deepEqual(after.totals, before.totals, "compaction must not move a single reported number");

  const retained = await readFile(manager.files.ledger, "utf8");
  assert.equal(retained.includes('"old"'), false);
  assert.match(await readFile(manager.files.archive, "utf8"), /"old"/);
  const rollups = JSON.parse(await readFile(manager.files.rollups, "utf8"));
  assert.equal(rollups.months["2026-01"]["codex:old"].tokens.total, 100);
});

test("leaves the ledger alone when nothing is older than the retention window", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  await manager.record({ agent: "codex", usage: { total_tokens: 1 } });
  const result = await manager.compactIfNeeded({ force: true });
  assert.equal(result.compacted, false);
  assert.equal(result.retained, 1);
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

test("retries transient OpenRouter read failures", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const attempts = new Map();
  const manager = createUsageManager({
    dataDir,
    retryOptions: { sleep: async () => {}, random: () => 0 },
    fetchImpl: async (url) => {
      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      if (count === 1) return new Response("busy", { status: 503 });
      const body = url.endsWith("credits") ? { data: { total_credits: 1, total_usage: 0 } } : { data: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
  });
  await manager.syncOpenRouter({ apiKey: "secret" });
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test("ratings and observed outcomes reorder recommendations", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({ dataDir, now: () => new Date("2026-08-10T12:00:00Z") });
  await manager.record({ agent: "codex", model: "default", runId: "r1", outcome: "failed", latencyMs: 100 });
  await manager.record({ agent: "opencode", model: "default", runId: "r2", outcome: "completed", latencyMs: 50 });
  await manager.rate({ runId: "r2", rating: 5, note: "excellent" });
  const recommendation = await manager.recommend({ task: "implement feature", profile: "standard" });
  assert.equal(recommendation.candidates[0], "opencode/default");
  assert.equal(recommendation.ratings[0].averageRating, 5);
  const ratings = await manager.ratings({ agent: "opencode" });
  assert.equal(ratings.entries[0].note, "excellent");
});

test("shadow routing records a sanitized comparison while returning the heuristic recommendation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const task = "Simple rename in a private customer component";
  const manager = createUsageManager({
    dataDir,
    routingProvider: "jev-shadow",
    routingAdvisor: {
      advise: async () => ({
        profile: "standard",
        profileConfidence: 0.72,
        requiresWrite: 0.95,
        complexity: 0.8,
        needsClarification: 0.1,
        distributions: {
          profile: { cheap: 0.2, standard: 0.72, premium: 0.08 },
          complexity: { 0: 0.3, 1: 0.6, 2: 0.1 }
        },
        confidence: { profile: 0.72, complexity: 0.6 },
        latencyMs: 24,
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        model: "jev-test"
      })
    }
  });

  const recommendation = await manager.recommend({ task, profile: "auto" });
  assert.equal(recommendation.profile, "cheap", "shadow advice must not alter the public result");
  assert.equal("routing" in recommendation, false, "the public response shape remains unchanged");

  const raw = await readFile(manager.files.routingShadow, "utf8");
  assert.equal(raw.includes(task), false);
  assert.equal(raw.includes("private customer"), false);
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.taskHash.length, 64);
  assert.equal(entry.heuristicProfile, "cheap");
  assert.equal(entry.jevProfile, "standard");
  assert.equal(entry.errorCategory, null);
});

test("shadow routing failures fall back and record only an error category", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  const manager = createUsageManager({
    dataDir,
    routingProvider: "jev-shadow",
    routingAdvisor: {
      advise: async () => { throw new JevRoutingError("authentication", "secret provider detail"); }
    }
  });

  const recommendation = await manager.recommend({ task: "Plan a compatibility migration", profile: "auto" });
  assert.equal(recommendation.profile, "premium");
  const raw = await readFile(manager.files.routingShadow, "utf8");
  assert.equal(raw.includes("secret provider detail"), false);
  assert.equal(JSON.parse(raw.trim()).errorCategory, "authentication");
});

test("explicit profiles never invoke the semantic routing advisor", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  let calls = 0;
  const manager = createUsageManager({
    dataDir,
    routingProvider: "jev-shadow",
    routingAdvisor: { advise: async () => { calls += 1; } }
  });
  const recommendation = await manager.recommend({ task: "Migration", profile: "standard" });
  assert.equal(recommendation.profile, "standard");
  assert.equal(calls, 0);
});

test("usage manager refuses active Jev routing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-usage-"));
  assert.throws(() => createUsageManager({ dataDir, routingProvider: "jev" }), /not enabled/);
});
