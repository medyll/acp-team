import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { evaluateRoutingResults } from "./routing-evaluation.js";

const corpus = JSON.parse(await readFile(new URL("./fixtures/routing-tasks.json", import.meta.url), "utf8"));

test("routing fixture corpus covers forty reviewed-before-activation cases", () => {
  assert.equal(corpus.reviewStatus, "needs-human-review");
  assert.equal(corpus.cases.length, 40);
  assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, 40);
  assert.deepEqual(new Set(corpus.cases.map(({ expected }) => expected.profile)), new Set(["cheap", "standard", "premium"]));
  assert.ok(corpus.cases.some(({ expected }) => expected.requiresWrite === false));
  assert.ok(corpus.cases.some(({ expected }) => expected.needsClarification === true));
});

test("evaluation reports confusion, false-cheap risk, latency, tokens, and fallbacks", () => {
  const observations = corpus.cases.map((sample, index) => ({
    id: sample.id,
    profile: index === 30 ? "cheap" : sample.expected.profile,
    profileConfidence: index === 30 ? 0.4 : 0.9,
    requiresWrite: sample.expected.requiresWrite ? 0.9 : 0.1,
    complexity: sample.expected.complexity,
    needsClarification: sample.expected.needsClarification ? 0.9 : 0.1,
    latencyMs: index + 1,
    usage: { inputTokens: 10, outputTokens: 2 }
  }));
  observations[39] = { id: corpus.cases[39].id, errorCategory: "rate-limit" };

  const report = evaluateRoutingResults(corpus, observations);
  assert.equal(report.total, 40);
  assert.equal(report.successful, 39);
  assert.equal(report.fallbackCount, 1);
  assert.equal(report.falseCheapCount, 1);
  assert.equal(report.falseCheapCases[0].id, corpus.cases[30].id);
  assert.equal(report.profileMistakes[0].predicted, "cheap");
  assert.equal(report.lowConfidenceMistakes, 1);
  assert.equal(report.requiresWriteAccuracy, 1);
  assert.equal(report.complexityAccuracy, 1);
  assert.equal(report.needsClarificationAccuracy, 1);
  assert.equal(report.confusionMatrix.premium.cheap, 1);
  assert.equal(report.p50LatencyMs, 20);
  assert.equal(report.p95LatencyMs, 38);
  assert.equal(report.averageInputTokens, 10);
  assert.equal(report.reportedCostPerRecommendation, null);
});
