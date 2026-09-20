const PROFILES = ["cheap", "standard", "premium"];

/**
 * Compare provider observations with a labeled corpus. This function reports
 * evidence only; none of its thresholds authorize runtime routing decisions.
 */
export function evaluateRoutingResults(corpus, observations, { lowConfidenceBelow = 0.6 } = {}) {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const confusionMatrix = Object.fromEntries(PROFILES.map((expected) => [
    expected,
    Object.fromEntries(PROFILES.map((predicted) => [predicted, 0]))
  ]));
  const successful = [];
  const failures = [];

  for (const sample of corpus.cases) {
    const observation = byId.get(sample.id);
    if (!observation || observation.errorCategory) {
      failures.push({ id: sample.id, errorCategory: observation?.errorCategory ?? "missing-result" });
      continue;
    }
    successful.push({ sample, observation });
    confusionMatrix[sample.expected.profile][observation.profile] += 1;
  }

  const mistakes = successful.filter(({ sample, observation }) => sample.expected.profile !== observation.profile);
  const falseCheap = successful.filter(({ sample, observation }) => sample.expected.profile !== "cheap" && observation.profile === "cheap");
  const lowConfidence = successful.filter(({ observation }) => Number.isFinite(observation.profileConfidence) && observation.profileConfidence < lowConfidenceBelow);
  const latencies = successful.map(({ observation }) => observation.latencyMs).filter(Number.isFinite).sort((left, right) => left - right);
  const inputTokens = successful.map(({ observation }) => observation.usage?.inputTokens).filter(Number.isFinite);
  const outputTokens = successful.map(({ observation }) => observation.usage?.outputTokens).filter(Number.isFinite);
  const requiresWrite = successful.filter(({ observation }) => Number.isFinite(observation.requiresWrite));
  const complexity = successful.filter(({ observation }) => Number.isFinite(observation.complexity));
  const needsClarification = successful.filter(({ observation }) => Number.isFinite(observation.needsClarification));

  // Noul values use 0.5 and Score values use the nearest rubric level solely to
  // make offline runs comparable. Production thresholds require reviewed data.
  return {
    reviewStatus: corpus.reviewStatus,
    total: corpus.cases.length,
    successful: successful.length,
    models: [...new Set(successful.map(({ observation }) => observation.model).filter(Boolean))],
    fallbackCount: failures.length,
    fallbackFrequency: ratio(failures.length, corpus.cases.length),
    profileAccuracy: ratio(successful.length - mistakes.length, successful.length),
    confusionMatrix,
    falseCheapCount: falseCheap.length,
    falseCheapFrequency: ratio(falseCheap.length, successful.length),
    lowConfidenceBelow,
    lowConfidenceCount: lowConfidence.length,
    lowConfidenceMistakes: lowConfidence.filter(({ sample, observation }) => sample.expected.profile !== observation.profile).length,
    profileMistakes: mistakes.map(({ sample, observation }) => ({
      id: sample.id,
      expected: sample.expected.profile,
      predicted: observation.profile,
      confidence: observation.profileConfidence ?? null
    })),
    falseCheapCases: falseCheap.map(({ sample, observation }) => ({
      id: sample.id,
      expected: sample.expected.profile,
      confidence: observation.profileConfidence ?? null
    })),
    requiresWriteAccuracy: dimensionAccuracy(requiresWrite, ({ sample, observation }) => (observation.requiresWrite >= 0.5) === sample.expected.requiresWrite),
    complexityAccuracy: dimensionAccuracy(complexity, ({ sample, observation }) => Math.round(observation.complexity) === sample.expected.complexity),
    needsClarificationAccuracy: dimensionAccuracy(needsClarification, ({ sample, observation }) => (observation.needsClarification >= 0.5) === sample.expected.needsClarification),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    averageInputTokens: average(inputTokens),
    averageOutputTokens: average(outputTokens),
    reportedCostPerRecommendation: null,
    failures
  };
}

function dimensionAccuracy(samples, matches) {
  return samples.length ? samples.filter(matches).length / samples.length : null;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  // Nearest-rank keeps the result on an observed latency, even for four-case smoke runs.
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}
