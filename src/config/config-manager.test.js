import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigManager, validateProposal } from "./config-manager.js";

test("stages, applies and rolls back a validated proposal", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-config-"));
  const manager = createConfigManager({ dataDir, now: () => new Date("2026-08-15T12:00:00Z") });
  await manager.ensure();
  await manager.set("budgets.periods.monthly", 20);
  const proposal = await manager.stage({ summary: "Raise budget", changes: [{ file: "budgets", path: "periods.monthly", value: 30, reason: "requested" }] });
  const applied = await manager.apply(proposal.id);
  assert.equal(await manager.get("budgets.periods.monthly"), 30);
  await manager.rollback(applied.backupId);
  assert.equal(await manager.get("budgets.periods.monthly"), 20);
});

test("rejects secret and unsafe proposal paths", () => {
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "provider.apiKey", value: "secret" }] }), /Secrets cannot/);
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "__proto__.polluted", value: true }] }), /Unsafe/);
});

test("writes settings as versioned JSON", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-settings-"));
  const manager = createConfigManager({ dataDir });
  await manager.ensure();
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(settings.schemaVersion, 1);
  assert.equal(settings.controller.default, "claude");
});
