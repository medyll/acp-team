import { createJevRoutingAdapter } from "./jev-routing-adapter.js";

const CASES = [
  { id: "typo", task: "Fix a typo in README.md with no source change." },
  { id: "bounded-feature", task: "Add a limited feature with unit tests in one subsystem." },
  { id: "migration", task: "Plan and execute a compatibility-sensitive architecture migration." },
  { id: "explanation", task: "Explain existing code without modifying files." }
];

const adapter = createJevRoutingAdapter({
  apiKey: process.env.TYPESAFE_API_KEY,
  timeoutMs: 15_000
});

const results = [];
for (const sample of CASES) {
  try {
    const advice = await adapter.advise(sample.task);
    results.push({
      id: sample.id,
      answers: {
        profile: advice.profile,
        requiresWrite: advice.requiresWrite,
        complexity: advice.complexity,
        needsClarification: advice.needsClarification
      },
      distributions: advice.distributions,
      confidence: advice.confidence,
      latencyMs: advice.latencyMs,
      usage: advice.usage,
      model: advice.model
    });
  } catch (error) {
    results.push({ id: sample.id, errorCategory: error.category ?? "unknown", message: error.message });
  }
}

console.log(JSON.stringify({ provider: "jev", syntheticOnly: true, cases: results }, null, 2));
if (results.some((result) => result.errorCategory)) process.exitCode = 1;
