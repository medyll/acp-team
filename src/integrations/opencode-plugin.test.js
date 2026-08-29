import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AcpTeamCallerInheritance, modeForOpenCodeAgent } from "./opencode-plugin.js";

test("maps OpenCode plan to read-only and every other model-running agent to write-capable", () => {
  assert.equal(modeForOpenCodeAgent("plan"), "plan");
  assert.equal(modeForOpenCodeAgent("build"), "default");
  assert.equal(modeForOpenCodeAgent("reviewer", "plan,reviewer"), "plan");
});

test("injects and overwrites caller context for ACP Team delegation tools", async () => {
  const hooks = await AcpTeamCallerInheritance({ directory: "/work" });
  await hooks["chat.message"]({ sessionID: "session-1", agent: "build" });
  const output = { args: { prompt: "fix", caller_context: { host: "forged", mode: "default" } } };

  await hooks["tool.execute.before"](
    { tool: "acp-team_agent_ask", sessionID: "session-1", callID: "call-1" },
    output
  );

  assert.deepEqual(output.args.caller_context, {
    host: "opencode",
    mode: "default",
    session_id: "session-1",
    cwd: path.resolve("/work")
  });
});

test("uses a read-only fallback for unknown sessions and ignores unrelated tools", async () => {
  const hooks = await AcpTeamCallerInheritance({ directory: "/work" });
  const delegated = { args: { prompt: "inspect" } };
  const unrelated = { args: { command: "pwd" } };

  await hooks["tool.execute.before"]({ tool: "acp-team_agent_start", sessionID: "unknown", callID: "call-1" }, delegated);
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "unknown", callID: "call-2" }, unrelated);

  assert.equal(delegated.args.caller_context.mode, "plan");
  assert.deepEqual(unrelated, { args: { command: "pwd" } });
});
