import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConfigManager } from "./config/config-manager.js";
import { diagnose } from "./doctor.js";

test("doctor reports configuration, filesystem and agent health", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-doctor-"));
  const configManager = createConfigManager({ dataDir });
  const adapter = { id: "fake", status: async () => ({ agent: { version: "1.0.0" } }) };
  const registry = { list: () => [adapter], get: () => adapter, stopAll() {} };
  const report = await diagnose({ configManager, registry, dataDir });
  assert.equal(report.healthy, true);
  assert.ok(report.checks.some((item) => item.id === "agent:fake" && item.status === "ok"));
});
