import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AcpClient } from "./acp-client.js";

test("ACP requests expire instead of remaining pending forever", async () => {
  const client = new AcpClient({ command: "fake", requestTimeoutMs: 5 });
  client.proc = { stdin: { write() {} } };
  // The production timeout is intentionally unref'ed so it cannot keep the
  // bridge alive. A real ACP child process supplies that event-loop handle;
  // this fake process does not, so keep the test runner alive explicitly.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(() => client.request("session/prompt", {}), /timed out/);
    assert.equal(client.pending.size, 0);
  } finally {
    clearInterval(keepAlive);
  }
});

test("spawns the ACP process in the configured working directory", async () => {
  const cwd = path.resolve("src");
  const script = `
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: 1, agentInfo: { name: process.cwd() } }
        }) + "\\n");
      }
    });
  `;
  const client = new AcpClient({ command: process.execPath, args: ["-e", script], cwd, requestTimeoutMs: 1_000 });
  try {
    const initialized = await client.start();
    assert.equal(initialized.agentInfo.name, cwd);
  } finally {
    client.stop();
  }
});
