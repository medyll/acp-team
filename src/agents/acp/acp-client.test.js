import assert from "node:assert/strict";
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
