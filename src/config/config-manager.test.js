import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

test("keeps only the most recent proposals and rollback snapshots", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-config-"));
  const manager = createConfigManager({ dataDir, retainedProposals: 3, retainedBackups: 2 });
  await manager.ensure();
  for (let index = 0; index < 6; index += 1) {
    const proposal = await manager.stage({
      id: `cfg_${String(index).padStart(4, "0")}`,
      summary: `change ${index}`,
      changes: [{ file: "budgets", path: "periods.monthly", value: index }]
    });
    await manager.apply(proposal.id);
  }

  const proposals = await readdir(manager.proposalsDir);
  const backups = await readdir(manager.historyDir);
  assert.equal(proposals.length, 3);
  assert.equal(backups.length, 2);
  assert.ok(proposals.includes("cfg_0005.json"), "the newest proposal survives pruning");
  assert.equal(await manager.get("budgets.periods.monthly"), 5, "pruning never touches the live configuration");
});

test("refuses configuration sections and keys that live on the prototype chain", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-config-"));
  const manager = createConfigManager({ dataDir });
  await manager.ensure();

  for (const key of ["__proto__.pwned", "constructor.pwned", "settings.__proto__.pwned"]) {
    await assert.rejects(manager.set(key, true), /Unsafe configuration property path|Unknown configuration section/, `set("${key}") must be refused by name`);
  }
  await assert.rejects(manager.get("__proto__.pwned"), /Unsafe configuration property path/);
  assert.throws(() => validateProposal({ changes: [{ file: "__proto__", path: "pwned", value: true }] }), /Unknown configuration section/);
  assert.throws(() => validateProposal({ changes: [{ file: "constructor", path: "pwned", value: true }] }), /Unknown configuration section/);
  assert.equal({}.pwned, undefined);
});

test("rejects secret and unsafe proposal paths", () => {
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "provider.apiKey", value: "secret" }] }), /Secrets cannot/);
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "__proto__.polluted", value: true }] }), /Unsafe/);
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "provider.password", value: "secret" }] }), /Secrets cannot/);
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "provider.credential", value: "secret" }] }), /Secrets cannot/);
  assert.throws(() => validateProposal({ changes: Array.from({ length: 101 }, () => ({ file: "settings", path: "safe", value: true })) }), /more than 100/);
  assert.throws(() => validateProposal({ changes: [{ file: "settings", path: "safe", value: "x".repeat(300_000) }] }), /too large/);
});

test("rejects secrets written directly through config set", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-config-"));
  const manager = createConfigManager({ dataDir });
  await assert.rejects(() => manager.set("provider.password", "secret"), /Secrets cannot/);
});

test("writes settings as versioned JSON", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-settings-"));
  const manager = createConfigManager({ dataDir });
  await manager.ensure();
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.controller.default, "claude");
  assert.equal(settings.runtime.maxConcurrentPerAgent, 2);
});

test("reads legacy settings through schema v2 defaults and migrates explicitly", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-settings-"));
  const manager = createConfigManager({ dataDir });
  await manager.ensure();
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ schemaVersion: 1, interaction: { language: "en" } }));
  const runtime = await manager.runtime();
  assert.equal(runtime.interaction.language, "en");
  assert.equal(runtime.runtime.resilience.retryAttempts, 3);
  await manager.migrate();
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")).schemaVersion, 2);
});
