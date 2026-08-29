import path from "node:path";

const DELEGATION_TOOL = /(?:^|_)agent_(?:ask|start|fanout)$|(?:^|_)run_retry$/;

/**
 * OpenCode host adapter for ACP Team caller-right inheritance.
 *
 * The hook runs after the model has produced tool arguments and overwrites any
 * model-supplied caller_context with the effective OpenCode session context.
 */
export const AcpTeamCallerInheritance = async ({ directory, worktree }) => {
  const sessionModes = new Map();
  const callerCwd = path.resolve(worktree || directory || process.cwd());

  const rememberAgent = ({ sessionID, agent }) => {
    if (sessionID && agent) sessionModes.set(sessionID, modeForOpenCodeAgent(agent));
  };

  return {
    "chat.message": async (input) => rememberAgent(input),
    "chat.params": async (input) => rememberAgent(input),
    "tool.execute.before": async (input, output) => {
      if (!DELEGATION_TOOL.test(input.tool)) return;
      output.args.caller_context = {
        host: "opencode",
        mode: sessionModes.get(input.sessionID) ?? "plan",
        session_id: input.sessionID,
        cwd: callerCwd
      };
    }
  };
};

export function modeForOpenCodeAgent(agent, planAgents = process.env.ACP_TEAM_OPENCODE_PLAN_AGENTS || "plan") {
  const readOnlyAgents = new Set(
    planAgents
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  return readOnlyAgents.has(agent) ? "plan" : "default";
}
