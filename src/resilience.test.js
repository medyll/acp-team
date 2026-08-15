import assert from "node:assert/strict";
import test from "node:test";
import { deadlineSignal, fetchWithRetry, readJsonResponse } from "./resilience.js";

test("deadlineSignal aborts a stalled operation", async () => {
  const deadline = deadlineSignal(undefined, 5, "test operation");
  await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve, { once: true }));
  assert.match(deadline.signal.reason.message, /timed out/);
  deadline.cleanup();
});

test("readJsonResponse rejects oversized streamed bodies", async () => {
  const response = new Response(JSON.stringify({ value: "x".repeat(100) }));
  await assert.rejects(() => readJsonResponse(response, { maxBytes: 20 }), /exceeds/);
});

test("fetchWithRetry retries transient reads and stops after success", async () => {
  let calls = 0;
  const response = await fetchWithRetry(async () => {
    calls += 1;
    return new Response("{}", { status: calls === 1 ? 503 : 200 });
  }, "https://example.test", {}, { sleep: async () => {}, random: () => 0 });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
