import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAuthorizationManager } from "./authorization-manager.js";

test("issues scoped one-time tokens without storing their plaintext", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir, now: () => new Date("2026-01-01T00:00:00Z") });
  const issued = await manager.issue({ agent: "codex", cwd: dataDir, mode: "default", ttlMs: 60_000 });
  assert.doesNotMatch(await readFile(manager.file, "utf8"), new RegExp(issued.token));
  await manager.consume({ token: issued.token, agent: "codex", cwd: dataDir, mode: "default" });
  await assert.rejects(() => manager.consume({ token: issued.token, agent: "codex", cwd: dataDir, mode: "default" }), /no remaining uses/);
});

test("rejects a token outside its agent or directory scope", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "codex", cwd: dataDir, mode: "auto", ttlMs: 60_000, uses: 2 });
  await assert.rejects(() => manager.consume({ token: issued.token, agent: "kimi", cwd: dataDir, mode: "auto" }), /scoped to agent/);
  await assert.rejects(() => manager.consume({ token: issued.token, agent: "codex", cwd: path.dirname(dataDir), mode: "auto" }), /scoped to/);
});

/** Remaining uses on the single entry in the store. */
async function usesLeft(manager) {
  const [entry] = await manager.list();
  return entry.usesRemaining;
}

test("a wildcard batch spends exactly one use per agent", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "*", cwd: dataDir, mode: "default", ttlMs: 60_000, uses: 3 });
  const consumed = await manager.consumeMany(
    ["kimi", "codex"].map((agent) => ({ token: issued.token, agent, cwd: dataDir, mode: "default" }))
  );
  assert.equal(consumed.length, 2);
  assert.equal(await usesLeft(manager), 1);
});

test("a batch outside the token's scope spends nothing", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  // Scoped to kimi with uses to spare: the first request would have passed, so
  // consuming request by request would have burned one before refusing codex.
  const issued = await manager.issue({ agent: "kimi", cwd: dataDir, mode: "default", ttlMs: 60_000, uses: 5 });
  await assert.rejects(
    () => manager.consumeMany(["kimi", "codex"].map((agent) => ({ token: issued.token, agent, cwd: dataDir, mode: "default" }))),
    /scoped to agent kimi/
  );
  assert.equal(await usesLeft(manager), 5, "a refused batch must leave the counter untouched");
});

test("a batch larger than the remaining uses spends nothing", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "*", cwd: dataDir, mode: "default", ttlMs: 60_000, uses: 2 });
  await assert.rejects(
    () => manager.consumeMany(["kimi", "codex", "opencode"].map((agent) => ({ token: issued.token, agent, cwd: dataDir, mode: "default" }))),
    /2 use\(s\) remaining but this batch needs 3/
  );
  assert.equal(await usesLeft(manager), 2);
});

test("an expired token or a foreign directory spends nothing in a batch", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const clock = { value: new Date("2026-01-01T00:00:00Z") };
  const manager = createAuthorizationManager({ dataDir, now: () => clock.value });
  const issued = await manager.issue({ agent: "*", cwd: dataDir, mode: "default", ttlMs: 60_000, uses: 4 });

  const foreign = [
    { token: issued.token, agent: "kimi", cwd: dataDir, mode: "default" },
    { token: issued.token, agent: "codex", cwd: path.dirname(dataDir), mode: "default" }
  ];
  await assert.rejects(() => manager.consumeMany(foreign), /scoped to/);
  assert.equal(await usesLeft(manager), 4);

  clock.value = new Date("2026-01-01T00:02:00Z");
  await assert.rejects(
    () => manager.consumeMany([{ token: issued.token, agent: "kimi", cwd: dataDir, mode: "default" }]),
    /has expired/
  );
  assert.equal(await usesLeft(manager), 4);
});

test("a read-only batch needs no token at all", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  assert.deepEqual(await manager.consumeMany([{ agent: "kimi", cwd: dataDir, mode: "plan" }]), { required: false });
});

test("concurrent batches cannot spend the same uses twice", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "*", cwd: dataDir, mode: "default", ttlMs: 60_000, uses: 3 });
  const batch = () => manager.consumeMany(["kimi", "codex"].map((agent) => ({ token: issued.token, agent, cwd: dataDir, mode: "default" })));

  const results = await Promise.allSettled([batch(), batch()]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await usesLeft(manager), 1, "only the batch that won the lock may spend");
});

test("serializes concurrent consumption of a one-use token", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "codex", cwd: dataDir, mode: "default", ttlMs: 60_000 });
  const results = await Promise.allSettled([
    manager.consume({ token: issued.token, agent: "codex", cwd: dataDir, mode: "default" }),
    manager.consume({ token: issued.token, agent: "codex", cwd: dataDir, mode: "default" })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
});

test("separate processes cannot spend a one-use token twice", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "acp-auth-process-"));
  const manager = createAuthorizationManager({ dataDir });
  const issued = await manager.issue({ agent: "codex", cwd: dataDir, mode: "default", ttlMs: 60_000 });
  const startAt = Date.now() + 500;
  const workers = Array.from({ length: 6 }, () => consumeInChild({ dataDir, cwd: dataDir, token: issued.token, startAt }));

  const results = await Promise.all(workers);
  assert.equal(results.filter((result) => result === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result === "rejected").length, 5);
  assert.equal(await usesLeft(manager), 0);
});

function consumeInChild({ dataDir, cwd, token, startAt }) {
  const moduleUrl = pathToFileURL(path.resolve("src/security/authorization-manager.js")).href;
  const source = `
    const [moduleUrl, dataDir, cwd, token, startAt] = process.argv.slice(1);
    const { createAuthorizationManager } = await import(moduleUrl);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
    try {
      await createAuthorizationManager({ dataDir }).consume({ token, agent: "codex", cwd, mode: "default" });
      process.stdout.write("fulfilled");
    } catch {
      process.stdout.write("rejected");
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, moduleUrl, dataDir, cwd, token, String(startAt)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`Authorization worker exited ${code}: ${stderr}`));
      resolve(stdout);
    });
  });
}
