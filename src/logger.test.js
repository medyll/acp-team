import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "./logger.js";

function capture(options) {
  const lines = [];
  return { lines, logger: createLogger({ write: (line) => lines.push(line), now: () => new Date("2026-01-01T00:00:00.000Z"), ...options }) };
}

test("drops messages below the configured level", () => {
  const { lines, logger } = capture({ level: "warn" });
  logger.debug("noisy");
  logger.info("routine");
  logger.warn("worth knowing");
  logger.error("broken");
  assert.deepEqual(lines.map((line) => line.trim()), ["[acp-team] warn: worth knowing", "[acp-team] error: broken"]);
});

test("emits one JSON object per line when asked", () => {
  const { lines, logger } = capture({ format: "json" });
  logger.info("ready", { agents: ["kimi"] });
  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-01-01T00:00:00.000Z",
    level: "info",
    name: "acp-team",
    message: "ready",
    agents: ["kimi"]
  });
});

test("stays callable as the bare log function adapters were written against", () => {
  const { lines, logger } = capture({});
  logger("codex: new thread");
  assert.equal(lines[0].trim(), "[acp-team] info: codex: new thread");
});

test("child loggers keep the parent's level and name their source", () => {
  const { lines, logger } = capture({ level: "debug" });
  logger.child("runs").debug("admitted");
  assert.equal(lines[0].trim(), "[acp-team:runs] debug: admitted");
});
