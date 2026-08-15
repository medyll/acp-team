import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "./cli.js";

test("parses --with and its French alias", () => {
  assert.deepEqual(parseArguments(["configure", "budget réduit", "--with", "opus", "--apply"]), {
    positionals: ["configure", "budget réduit"], options: { with: "opus", apply: true }
  });
  assert.deepEqual(parseArguments(["configure", "--avec=sonnet"]), {
    positionals: ["configure"], options: { avec: "sonnet" }
  });
});

test("parses operational boolean flags without consuming the next argument", () => {
  assert.deepEqual(parseArguments(["compat", "test", "codex", "--live"]), {
    positionals: ["compat", "test", "codex"], options: { live: true }
  });
  assert.deepEqual(parseArguments(["doctor", "--fix", "--yes"]), {
    positionals: ["doctor"], options: { fix: true, yes: true }
  });
});
