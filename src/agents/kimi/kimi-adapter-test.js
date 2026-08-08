// Regression test: a session reused implicitly by cwd must still accept model,
// mode and thinking overrides. Before the fix these were applied only when the
// caller passed session_id explicitly, and were silently dropped otherwise.
// Usage: node src/agents/kimi/kimi-adapter-test.js
import { createKimiAdapter } from "./kimi-adapter.js";

const kimi = createKimiAdapter({
  defaultMode: "plan",
  permissionPolicy: "deny",
  log: (m) => console.error(m)
});

const cwd = process.cwd();
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
};

// Turn 1 creates the session for this cwd.
const first = await kimi.ask({ prompt: "Reply with exactly: ONE", cwd, mode: "plan" });
check("turn 1 answers", first.text.includes("ONE"));

// Turn 2 reuses it by cwd while overriding model and thinking. The override call
// throws if the config request is malformed, which is what the fix guards.
const second = await kimi.ask({
  prompt: "Reply with exactly: TWO",
  cwd,
  model: "kimi-code/k3",
  thinking: "low",
  mode: "plan"
});
check("turn 2 answers", second.text.includes("TWO"));
check("session reused across turns", first.sessionId === second.sessionId);

// An explicit session id must take the same path.
const third = await kimi.ask({
  prompt: "Reply with exactly: THREE",
  cwd,
  session_id: undefined,
  sessionId: first.sessionId,
  model: "kimi-code/kimi-for-coding"
});
check("explicit session id honored", third.sessionId === first.sessionId && third.text.includes("THREE"));

kimi.stop();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
