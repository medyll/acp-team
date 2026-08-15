import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunJournal } from "./run-journal.js";

async function journalDir() {
  return mkdtemp(path.join(tmpdir(), "acp-journal-"));
}

test("writes one line per lifecycle event and reads it back per run", async () => {
  const journal = createRunJournal({ dataDir: await journalDir() });
  journal.record({ runId: "r1", agent: "kimi", status: "queued", event: { type: "run.queued", at: "2026-01-01T00:00:00.000Z" } });
  journal.record({ runId: "r2", agent: "codex", status: "queued", event: { type: "run.queued" } });
  await journal.record({ runId: "r1", agent: "kimi", status: "completed", sessionId: "s1", event: { type: "run.completed" } });

  const all = await journal.history();
  assert.equal(all.length, 3);
  const first = await journal.history({ runId: "r1" });
  assert.deepEqual(first.map((entry) => entry.event), ["run.queued", "run.completed"]);
  assert.equal(first[0].at, "2026-01-01T00:00:00.000Z");
  assert.equal(first[1].sessionId, "s1");
});

test("a write failure never rejects into the run that triggered it", async () => {
  const errors = [];
  const journal = createRunJournal({ dataDir: path.join(await journalDir(), "nested"), onError: (error) => errors.push(error) });
  // A file where the data directory should be makes every write fail.
  await writeFile(path.dirname(journal.file), "not a directory", "utf8").catch(() => {});

  await journal.record({ runId: "r1", agent: "kimi", status: "failed", event: { type: "run.failed" } });
  await journal.flush();
  assert.equal(errors.length, 1);
});

test("survives a line truncated by a crash", async () => {
  const dataDir = await journalDir();
  const journal = createRunJournal({ dataDir });
  await journal.record({ runId: "r1", agent: "kimi", status: "queued", event: { type: "run.queued" } });
  const raw = await readFile(journal.file, "utf8");
  await writeFile(journal.file, `${raw}{"runId":"r2","age`, "utf8");

  const entries = await journal.history();
  assert.deepEqual(entries.map((entry) => entry.runId), ["r1"]);
});

test("rotates past the size limit and keeps history across generations", async () => {
  const dataDir = await journalDir();
  const journal = createRunJournal({ dataDir, maxBytes: 200, retainedFiles: 20 });
  for (let index = 0; index < 20; index += 1) {
    await journal.record({ runId: `r${index}`, agent: "kimi", status: "queued", event: { type: "run.queued" } });
  }

  const generations = (await readdir(dataDir)).filter((name) => name !== "runs.jsonl");
  assert.ok(generations.length > 1, "each rotation gets its own generation instead of overwriting one file");
  const entries = await journal.history({ limit: 100 });
  assert.deepEqual(entries.map((entry) => entry.runId), Array.from({ length: 20 }, (_, index) => `r${index}`));
});

test("drops the oldest generations beyond the retention count", async () => {
  const dataDir = await journalDir();
  const journal = createRunJournal({ dataDir, maxBytes: 200, retainedFiles: 2 });
  for (let index = 0; index < 20; index += 1) {
    await journal.record({ runId: `r${index}`, agent: "kimi", status: "queued", event: { type: "run.queued" } });
  }
  const generations = (await readdir(dataDir)).filter((name) => name !== "runs.jsonl");
  assert.equal(generations.length, 2);
  const entries = await journal.history();
  assert.ok(entries.length < 20, "pruned generations are gone");
  assert.equal(entries.at(-1).runId, "r19", "the newest entries are the ones kept");
});
