import { readFile } from "node:fs/promises";
import { createJevRoutingAdapter } from "./jev-routing-adapter.js";
import { evaluateRoutingResults } from "./routing-evaluation.js";
import { inferProfile } from "./usage-manager.js";

const corpus = JSON.parse(await readFile(new URL("./fixtures/routing-tasks.json", import.meta.url), "utf8"));
const adapter = createJevRoutingAdapter({ apiKey: process.env.TYPESAFE_API_KEY, timeoutMs: 15_000 });
const observations = [];

for (const sample of corpus.cases) {
  try {
    const advice = await adapter.advise(sample.task);
    observations.push({ id: sample.id, ...advice });
  } catch (error) {
    observations.push({ id: sample.id, errorCategory: error.category ?? "unknown" });
  }
}

const heuristic = corpus.cases.map((sample) => ({ id: sample.id, profile: inferProfile(sample.task) }));
console.log(JSON.stringify({
  reviewStatus: corpus.reviewStatus,
  heuristic: evaluateRoutingResults(corpus, heuristic),
  jev: evaluateRoutingResults(corpus, observations)
}, null, 2));
if (observations.some(({ errorCategory }) => errorCategory)) process.exitCode = 1;
