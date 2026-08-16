import { access } from "node:fs/promises";
import { constants } from "node:fs";

export async function diagnose({ configManager, registry, dataDir, agent, timeoutMs = 5_000, stopAfter = false } = {}) {
  const checks = [];
  checks.push(check("node", Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node}`, "Node 20 or later is required"));
  try {
    const snapshot = await configManager.inspect();
    checks.push(check("configuration", snapshot.files.settings.schemaVersion >= 2, `schema v${snapshot.files.settings.schemaVersion}`, "Run doctor --fix to migrate settings"));
  } catch (error) {
    checks.push(failure("configuration", error));
  }
  try {
    await access(dataDir, constants.R_OK | constants.W_OK);
    checks.push(check("data-directory", true, dataDir));
  } catch (error) {
    checks.push(failure("data-directory", error));
  }

  const targets = agent ? [registry.get(agent)] : registry.list();
  for (const adapter of targets) {
    try {
      const status = await withTimeout(adapter.status(), timeoutMs, `${adapter.id} status`);
      const installed = !["not installed", "unknown", undefined].includes(status.agent?.version);
      checks.push(check(`agent:${adapter.id}`, installed, status.agent?.version ?? "available", "Install or authenticate the agent CLI"));
    } catch (error) {
      checks.push(failure(`agent:${adapter.id}`, error));
    }
  }
  if (stopAfter) registry.stopAll();
  return summarize(checks);
}

export async function repair({ configManager } = {}) {
  return configManager.migrate();
}

function check(id, ok, detail, remediation) {
  return { id, status: ok ? "ok" : "warning", detail, ...(ok || !remediation ? {} : { remediation }) };
}

function failure(id, error) {
  return { id, status: "error", detail: error.message };
}

function summarize(checks) {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const item of checks) counts[item.status] += 1;
  return { healthy: counts.error === 0, counts, checks };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
