import assert from "node:assert/strict";
import test from "node:test";
import { resolveDelegationAccess, trustedCallerHosts } from "./caller-context.js";

const trusted = new Set(["opencode"]);
const caller = { host: "opencode", mode: "default", session_id: "session-1", cwd: "/work" };

test("inherits a trusted caller mode when the callee does not override it", () => {
  const access = resolveDelegationAccess({ callerContext: caller, cwd: "/work/project", trustedHosts: trusted });
  assert.equal(access.mode, "default");
  assert.equal(access.inherited, true);
  assert.equal(access.requiresAuthorization, false);
  assert.equal(access.permissionSource, "caller");
});

test("an explicit callee mode can reduce inherited rights", () => {
  const access = resolveDelegationAccess({ requestedMode: "plan", callerContext: caller, cwd: "/work", trustedHosts: trusted });
  assert.equal(access.mode, "plan");
  assert.equal(access.inherited, false);
  assert.equal(access.requiresAuthorization, false);
});

test("a callee elevation still requires authorization", () => {
  const access = resolveDelegationAccess({
    requestedMode: "default",
    callerContext: { ...caller, mode: "plan" },
    cwd: "/work",
    trustedHosts: trusted
  });
  assert.equal(access.mode, "default");
  assert.equal(access.requiresAuthorization, true);
});

test("caller rights do not escape their workspace", () => {
  const access = resolveDelegationAccess({ callerContext: caller, cwd: "/other", trustedHosts: trusted });
  assert.equal(access.mode, "default");
  assert.equal(access.requiresAuthorization, true);
});

test("untrusted or absent contexts preserve the read-only default", () => {
  assert.equal(resolveDelegationAccess({ callerContext: caller, cwd: "/work" }).mode, "plan");
  assert.equal(resolveDelegationAccess({ cwd: "/work", trustedHosts: trusted }).mode, "plan");
});

test("trusted host configuration is normalized", () => {
  assert.deepEqual([...trustedCallerHosts(" OpenCode,OTHER ,, ")], ["opencode", "other"]);
});
