import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
