import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "./acp-client.js";

test("ACP requests expire instead of remaining pending forever", async () => {
  const client = new AcpClient({ command: "fake", requestTimeoutMs: 5 });
  client.proc = { stdin: { write() {} } };
  await assert.rejects(() => client.request("session/prompt", {}), /timed out/);
  assert.equal(client.pending.size, 0);
});
