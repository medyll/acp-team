import assert from "node:assert/strict";
import test from "node:test";
import { authorizeMode, requiresWriteAuthorization } from "./security-policy.js";

test("agent modes default to read-only and identify write-capable modes", () => {
  assert.equal(authorizeMode(), "plan");
  assert.equal(authorizeMode("plan"), "plan");
  assert.equal(authorizeMode("default"), "default");
  assert.equal(authorizeMode("auto"), "auto");
  assert.equal(requiresWriteAuthorization("plan"), false);
  assert.equal(requiresWriteAuthorization("default"), true);
  assert.throws(() => authorizeMode("yolo"), /Unsupported agent mode/);
});
