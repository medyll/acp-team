import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { main, parseArguments } from "./cli.js";

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

function createFakeTerminal({ interactive = false } = {}) {
  const lines = [];
  return {
    lines,
    interactive,
    log: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    phase: () => {},
    ask: async () => "",
    confirm: async (_message, fallback = false) => fallback,
    close: () => {}
  };
}

test("authorize grant refuses to no-op silently in a non-interactive terminal", async () => {
  const terminal = createFakeTerminal({ interactive: false });
  await assert.rejects(
    main(["authorize", "grant", "--agent", "codex", "--mode", "default"], terminal),
    /requires --yes in a non-interactive terminal/
  );
  assert.deepEqual(terminal.lines, []);
});

test("the token store stays with the bridge when --cwd scopes another directory", async (t) => {
  const bridgeDir = await mkdtemp(path.join(tmpdir(), "acp-bridge-"));
  const scopeDir = await mkdtemp(path.join(tmpdir(), "acp-scope-"));
  const previousBridgeCwd = process.env.AGENT_BRIDGE_CWD;
  const previousDataDir = process.env.AGENT_BRIDGE_DATA_DIR;
  process.env.AGENT_BRIDGE_CWD = bridgeDir;
  delete process.env.AGENT_BRIDGE_DATA_DIR;
  t.after(async () => {
    if (previousBridgeCwd === undefined) delete process.env.AGENT_BRIDGE_CWD;
    else process.env.AGENT_BRIDGE_CWD = previousBridgeCwd;
    if (previousDataDir !== undefined) process.env.AGENT_BRIDGE_DATA_DIR = previousDataDir;
    await rm(bridgeDir, { recursive: true, force: true });
    await rm(scopeDir, { recursive: true, force: true });
  });

  const terminal = createFakeTerminal();
  await main(["authorize", "grant", "--agent", "codex", "--cwd", scopeDir, "--mode", "default", "--yes"], terminal);

  const issued = JSON.parse(terminal.lines.at(-1));
  assert.equal(issued.authorization.cwd, path.resolve(scopeDir));
  await access(path.join(bridgeDir, ".acp-team", "authorizations.json"));
  await assert.rejects(access(path.join(scopeDir, ".acp-team")));
});
