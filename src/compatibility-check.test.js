import assert from "node:assert/strict";
import test from "node:test";
import { checkCompatibility } from "./compatibility-check.js";

test("compatibility probes are read-only and opt-in", async () => {
  const calls = [];
  const adapter = {
    id: "fake",
    status: async () => ({ agent: { version: "1" } }),
    ask: async (options) => { calls.push(options); return { text: "ACP_TEAM_OK" }; }
  };
  const registry = { ids: ["fake"], get: () => adapter, stopAll() {} };
  const passive = await checkCompatibility({ registry });
  assert.equal(passive.results[0].status, "available");
  assert.equal(calls.length, 0);
  const live = await checkCompatibility({ registry, live: true, cwd: "C:/work" });
  assert.equal(live.results[0].probe, "passed");
  assert.equal(calls[0].mode, "plan");
});
