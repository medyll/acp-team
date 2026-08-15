import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createTerminal, withProgress } from "./terminal.js";

function streams({ tty = false } = {}) {
  const output = new PassThrough();
  const error = new PassThrough();
  const input = new PassThrough();
  input.isTTY = tty;
  output.isTTY = tty;
  const collect = (stream) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    return () => chunks.join("");
  };
  return { input, output, error, readOutput: collect(output), readError: collect(error) };
}

test("answers go to stdout and diagnostics to stderr", async () => {
  const { input, output, error, readOutput, readError } = streams();
  const terminal = createTerminal({ input, output, error });
  terminal.log("result");
  terminal.warn("careful");
  terminal.phase("working");
  await new Promise(setImmediate);
  assert.equal(readOutput(), "result\n");
  assert.equal(readError(), "careful\n[acp-team] working\n");
});

test("a non-interactive terminal takes the fallback instead of blocking on a prompt", async () => {
  const { input, output, error } = streams({ tty: false });
  const terminal = createTerminal({ input, output, error });
  assert.equal(terminal.interactive, false);
  assert.equal(await terminal.ask("Which model?", "default"), "default");
  assert.equal(await terminal.confirm("Apply?"), false);
  assert.equal(await terminal.confirm("Apply?", true), true, "a piped run must not silently refuse an approved default");
});

test("logging an empty message still emits a blank line", async () => {
  const { input, output, error, readOutput } = streams();
  createTerminal({ input, output, error }).log();
  await new Promise(setImmediate);
  assert.equal(readOutput(), "\n");
});

test("withProgress announces both ends of a long operation and clears its timer", async () => {
  const phases = [];
  const terminal = { phase: (message) => phases.push(message) };
  const result = await withProgress(terminal, "Recherche", async () => "done");
  assert.equal(result, "done");
  assert.deepEqual(phases, ["Recherche…", "Recherche — terminé"]);
});

test("a failing operation still stops the progress timer", async () => {
  const terminal = { phase: () => {} };
  await assert.rejects(
    withProgress(terminal, "Recherche", async () => {
      throw new Error("network down");
    }),
    /network down/
  );
});
