import assert from "node:assert/strict";
import test from "node:test";
import { authorizeMode, WRITE_CONFIRMATION, YOLO_CONFIRMATION } from "./security-policy.js";

test("agent modes default to read-only and powerful modes require acknowledgement", () => {
  assert.equal(authorizeMode(), "plan");
  assert.equal(authorizeMode("plan"), "plan");
  assert.throws(() => authorizeMode("default"), /requires confirm_write/);
  assert.equal(authorizeMode("auto", { confirmWrite: WRITE_CONFIRMATION }), "auto");
  assert.throws(() => authorizeMode("yolo"), /requires confirm_yolo/);
  assert.equal(authorizeMode("yolo", { confirmYolo: YOLO_CONFIRMATION }), "yolo");
});
