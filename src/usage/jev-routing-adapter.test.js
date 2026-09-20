import assert from "node:assert/strict";
import test from "node:test";
import {
  createJevRoutingAdapter,
  routingOptionsFromEnvironment
} from "./jev-routing-adapter.js";

const VALID_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    profile: {
      type: "choice",
      choice: "standard",
      confidence: 0.8,
      probabilities: { cheap: 0.1, standard: 0.8, premium: 0.1 }
    },
    requires_write: { type: "noul", noul: 0.9 },
    complexity: {
      type: "score",
      score: 1.1,
      confidence: 0.7,
      legend: { 0: "mechanical", 1: "normal", 2: "high-risk" },
      probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 }
    },
    needs_clarification: { type: "noul", noul: 0.2 }
  },
  usage: { input_tokens: 42, output_tokens: 4 }
};

test("maps a valid Jev response to routing advice without widening the task state", async () => {
  const calls = [];
  const times = [100, 135];
  const adapter = createJevRoutingAdapter({
    apiKey: "test-secret",
    clock: { now: () => times.shift() },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(VALID_RESPONSE);
    }
  });

  const advice = await adapter.advise("Add a bounded feature with tests.");
  assert.equal(advice.profile, "standard");
  assert.equal(advice.requiresWrite, 0.9);
  assert.equal(advice.complexity, 1.1);
  assert.equal(advice.latencyMs, 35);
  assert.deepEqual(advice.usage, { inputTokens: 42, outputTokens: 4, totalTokens: 46 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.state, { task: "Add a bounded feature with tests." });
  assert.deepEqual(Object.keys(body.questions), ["profile", "requires_write", "complexity", "needs_clarification"]);
});

test("classifies missing keys without making a request", async () => {
  let called = false;
  const adapter = createJevRoutingAdapter({ fetchImpl: async () => { called = true; } });
  await assert.rejects(() => adapter.advise("Explain the code."), (error) => error.category === "missing-key");
  assert.equal(called, false);
});

test("classifies authentication and rate-limit failures", async () => {
  for (const [status, category] of [[401, "authentication"], [429, "rate-limit"]]) {
    const adapter = createJevRoutingAdapter({
      apiKey: "invalid",
      retryOptions: { attempts: 1 },
      fetchImpl: async () => jsonResponse({ message: "rejected" }, status)
    });
    await assert.rejects(() => adapter.advise("Fix a bug."), (error) => error.category === category && error.status === status);
  }
});

test("retries TypeSafe overload responses before returning advice", async () => {
  let attempts = 0;
  const adapter = createJevRoutingAdapter({
    apiKey: "test",
    retryOptions: { attempts: 2, sleep: async () => {}, random: () => 0 },
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ message: "overloaded" }, 529) : jsonResponse(VALID_RESPONSE);
    }
  });
  assert.equal((await adapter.advise("Fix a bounded bug.")).profile, "standard");
  assert.equal(attempts, 2);
});

test("classifies stalled requests as timeouts", async () => {
  const adapter = createJevRoutingAdapter({
    apiKey: "test",
    timeoutMs: 5,
    retryOptions: { attempts: 1 },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  await assert.rejects(() => adapter.advise("Investigate an intermittent failure."), (error) => error.category === "timeout");
});

test("rejects malformed successful responses", async () => {
  const adapter = createJevRoutingAdapter({
    apiKey: "test",
    fetchImpl: async () => jsonResponse({ model: "jev-latest", answers: {}, usage: {} })
  });
  await assert.rejects(() => adapter.advise("Review this code."), (error) => error.category === "malformed-response");
});

test("environment routing is opt-in and active Jev mode remains gated", () => {
  assert.deepEqual(routingOptionsFromEnvironment({ env: {} }), { routingProvider: "heuristic" });
  const shadow = routingOptionsFromEnvironment({ env: { ACP_TEAM_ROUTING_PROVIDER: "jev-shadow" } });
  assert.equal(shadow.routingProvider, "jev-shadow");
  assert.equal(typeof shadow.routingAdvisor.advise, "function");
  assert.throws(
    () => routingOptionsFromEnvironment({ env: { ACP_TEAM_ROUTING_PROVIDER: "jev" } }),
    /intentionally unavailable/
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
