import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 5;
const ROTATED_PATTERN = /^runs\.\d+\.jsonl$/;

/**
 * Append-only lifecycle trail for supervised runs.
 *
 * Live run state stays in memory on purpose — a restarted bridge owns no agent
 * sessions and could not resume anything. What survives a crash here is the
 * record of what was asked, what happened and why it ended, so a host can still
 * explain the session after the fact.
 *
 * Writes are fire-and-forget: journalling must never slow a delegation down or
 * fail a run because a disk is full.
 */
export function createRunJournal({
  dataDir,
  maxBytes = DEFAULT_MAX_BYTES,
  retainedFiles = DEFAULT_RETAINED_FILES,
  now = () => Date.now(),
  onError = () => {}
} = {}) {
  if (!dataDir) throw new Error("Run journal requires a dataDir");
  const file = path.join(dataDir, "runs.jsonl");
  let tail = Promise.resolve();
  let lastStamp = 0;

  function record({ runId, agent, status, sessionId, event }) {
    const line = `${JSON.stringify({
      at: event?.at ?? new Date().toISOString(),
      runId,
      agent,
      status,
      ...(sessionId ? { sessionId } : {}),
      event: event?.type ?? "run.unknown",
      ...(event?.error ? { error: event.error } : {}),
      ...(event?.reason ? { reason: event.reason } : {})
    })}\n`;

    tail = tail
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        await rotateIfNeeded();
        await appendFile(file, line, "utf8");
      })
      .catch((error) => onError(error));
    return tail;
  }

  /**
   * Each rotation gets its own generation rather than overwriting a single
   * `.1` file, so a busy bridge that rotates repeatedly keeps a real window of
   * history instead of only the last few lines.
   */
  async function rotateIfNeeded() {
    try {
      const info = await stat(file);
      if (info.size < maxBytes) return;
    } catch {
      return;
    }
    lastStamp = Math.max(now(), lastStamp + 1);
    await rename(file, path.join(dataDir, `runs.${lastStamp}.jsonl`));
    await prune();
  }

  async function prune() {
    const rotated = (await readdir(dataDir)).filter((name) => ROTATED_PATTERN.test(name)).sort();
    for (const name of rotated.slice(0, Math.max(0, rotated.length - retainedFiles))) {
      await unlink(path.join(dataDir, name)).catch(() => {});
    }
  }

  /** Read newest-first across generations, stopping as soon as limit is met. */
  async function history({ runId, limit = 100 } = {}) {
    let names;
    try {
      names = (await readdir(dataDir)).filter((name) => ROTATED_PATTERN.test(name)).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const collected = [];
    for (const name of [...names, path.basename(file)]) {
      collected.push(...(await readGeneration(path.join(dataDir, name), runId)));
    }
    return collected.slice(-limit);
  }

  async function readGeneration(target, runId) {
    let raw;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!runId || entry.runId === runId) entries.push(entry);
      } catch {
        // A truncated final line after a crash is expected; skip it.
      }
    }
    return entries;
  }

  /** Resolve every pending write; tests and shutdown need a settled journal. */
  function flush() {
    return tail;
  }

  return { record, history, flush, file };
}
