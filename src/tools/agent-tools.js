import { z } from "zod";
import { MODES } from "../agents/agent.js";
import { authorizeMode, requiresWriteAuthorization } from "../security-policy.js";
import { jsonResult, progressReporter, render, textResult } from "./shared.js";

/** Delegation options every agent tool accepts, kept in one place so the
 *  blocking, supervised and fan-out entry points cannot drift apart. */
function delegationShape(AgentId) {
  return {
    prompt: z.string().describe("Instruction or question to send."),
    cwd: z.string().optional().describe("Working directory the agent operates in. Defaults to the bridge cwd."),
    session_id: z.string().optional().describe("Existing session/thread to continue."),
    new_session: z.boolean().optional().describe("Force a fresh session instead of reusing the one for this cwd."),
    model: z.string().optional().describe("Model override supported by the selected agent."),
    mode: z.enum(MODES).optional().describe("Permission/sandbox mode: plan is read-only; default and auto allow workspace writes."),
    authorization: z.string().optional().describe("Scoped token issued by `acp-team authorize grant`; required for write-capable modes."),
    thinking: z.enum(["low", "high", "max", "on"]).optional().describe("Reasoning effort (kimi only)."),
    options: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        "Free-form model/agent settings. For codex these become `-c key=value` overrides; ACP agents apply them as session config options. Invalid keys or values are reported by the agent."
      ),
    agent: AgentId.describe("Which agent to delegate to.")
  };
}

export function registerAgentTools(server, { registry, runManager, usageManager, authorizationManager, journal, defaultCwd, log }) {
  const AgentId = z.enum(registry.ids);
  const shape = delegationShape(AgentId);

  server.registerTool(
    "agent_ask",
    {
      title: "Ask a teammate agent",
      description:
        "Delegate a task to another coding agent. The agent runs its own tools — file reads/writes, shell — inside the given working directory, and returns its final answer plus a summary of what it ran. Conversation state is kept per agent per working directory unless session_id or new_session is given.",
      inputSchema: {
        ...shape,
        return: z.enum(["summary", "full"]).default("summary").describe("Return the compact tool-call summary or the full tool-call list."),
        include_thoughts: z.boolean().optional().describe("Include the agent's reasoning stream in the output.")
      }
    },
    async (input, extra) => {
      const startedAt = Date.now();
      const mode = authorizeMode(input.mode);
      if (requiresWriteAuthorization(mode)) await authorizationManager.consume({ token: input.authorization, agent: input.agent, cwd: input.cwd || defaultCwd, mode });
      const result = await registry.get(input.agent).ask({
        prompt: input.prompt,
        cwd: input.cwd || defaultCwd,
        sessionId: input.session_id,
        newSession: input.new_session,
        model: input.model,
        mode,
        thinking: input.thinking,
        options: input.options,
        signal: extra?.signal,
        onEvent: progressReporter(extra, log)
      });
      await usageManager.record({ agent: input.agent, model: input.model, sessionId: result.sessionId, usage: result.usage, cost: result.cost, outcome: "completed", latencyMs: Date.now() - startedAt });
      return textResult(
        render({
          agent: input.agent,
          result,
          includeThoughts: input.include_thoughts,
          returnMode: input.include_thoughts ? "full" : input.return ?? "summary"
        })
      );
    }
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start a supervised agent run",
      description:
        "Start an agent turn in the background and return a run_id immediately. Use agent_watch to observe it and agent_stop to interrupt it. A run may wait when its agent is already at its concurrency limit.",
      inputSchema: shape
    },
    async (input) => {
      const mode = authorizeMode(input.mode);
      if (requiresWriteAuthorization(mode)) await authorizationManager.consume({ token: input.authorization, agent: input.agent, cwd: input.cwd || defaultCwd, mode });
      return jsonResult(
        runManager.start({
          agent: input.agent,
          prompt: input.prompt,
          cwd: input.cwd || defaultCwd,
          sessionId: input.session_id,
          newSession: input.new_session,
          model: input.model,
          mode,
          thinking: input.thinking,
          options: input.options
        })
      );
    }
  );

  server.registerTool(
    "agent_fanout",
    {
      title: "Ask several agents the same question",
      description:
        "Send one prompt to several agents as supervised runs and return their run ids. Use it to compare how different agents approach the same problem, then read each result with agent_watch. Each run is subject to its agent's concurrency limit. In a write-capable mode every agent consumes one use of the token, so the authorization must cover all of them.",
      inputSchema: {
        prompt: shape.prompt,
        agents: z.array(AgentId).min(2).max(6).describe("Agents to ask. Each one gets its own independent run."),
        cwd: shape.cwd,
        mode: shape.mode,
        authorization: shape.authorization,
        models: z
          .record(z.string())
          .optional()
          .describe("Per-agent model override, keyed by agent id. Agents without an entry use their default.")
      }
    },
    async ({ prompt, agents, cwd, mode, authorization, models }) => {
      const authorizedMode = authorizeMode(mode);
      const unique = [...new Set(agents)];
      const workingDirectory = cwd || defaultCwd;

      // Authorize the fan-out as one transaction. A token scoped to a single
      // agent, or with fewer uses than there are agents, would otherwise let the
      // first run write while the rest were refused — a partial fan-out nobody
      // approved — and spend uses on the way to failing.
      if (requiresWriteAuthorization(authorizedMode)) {
        try {
          await authorizationManager.consumeMany(
            unique.map((agent) => ({ token: authorization, agent, cwd: workingDirectory, mode: authorizedMode }))
          );
        } catch (error) {
          throw new Error(
            `Authorization does not cover this fan-out: ${error.message}. Grant a token scoped to every agent, with at least ${unique.length} uses.`
          );
        }
      }

      const runs = [];
      for (const agent of unique) {
        try {
          runs.push({
            agent,
            ...runManager.start({
              agent,
              prompt,
              cwd: cwd || defaultCwd,
              newSession: true,
              model: models?.[agent],
              mode: authorizedMode
            })
          });
        } catch (error) {
          // One unavailable agent must not sink the whole comparison.
          runs.push({ agent, status: "rejected", error: { message: error.message } });
        }
      }
      return jsonResult({ prompt, mode: authorizedMode, runs });
    }
  );

  server.registerTool(
    "run_history",
    {
      title: "Read persisted run history",
      description: "Read lifecycle-only run history across bridge restarts. Prompts, answers and reasoning are never journalled.",
      inputSchema: { agent: AgentId.optional(), limit: z.number().int().min(1).max(1000).optional() }
    },
    async ({ agent, limit }) => {
      const entries = await journal.history({ limit: Math.min(5000, (limit ?? 100) * 10) });
      return jsonResult(entries.filter((entry) => !agent || entry.agent === agent).slice(-(limit ?? 100)));
    }
  );

  server.registerTool(
    "run_show",
    {
      title: "Show a run",
      description: "Show live details for a retained run, or its persisted lifecycle after a restart.",
      inputSchema: { run_id: z.string() }
    },
    async ({ run_id }) => {
      try { return jsonResult(runManager.show(run_id)); } catch {
        const entries = await journal.history({ runId: run_id, limit: 1000 });
        if (!entries.length) throw new Error(`Unknown run "${run_id}".`);
        return jsonResult({ runId: run_id, persisted: true, events: entries });
      }
    }
  );

  server.registerTool(
    "run_retry",
    {
      title: "Retry a retained run",
      description: "Retry a finished run still retained in memory. Restarted bridges cannot recover prompts because prompts are deliberately not journalled.",
      inputSchema: { run_id: z.string(), authorization: z.string().optional() }
    },
    async ({ run_id, authorization }) => {
      const scope = runManager.retryScope(run_id);
      if (requiresWriteAuthorization(scope.mode)) await authorizationManager.consume({ token: authorization, ...scope });
      return jsonResult(runManager.retry(run_id));
    }
  );

  server.registerTool(
    "agent_watch",
    {
      title: "Watch a supervised agent run",
      description:
        "Return a compact progress report for a run: elapsed, queue, active and idle time, health, phase, last visible message and tool counts. Pass return='events' for the underlying event stream. wait_ms enables bounded long-polling.",
      inputSchema: {
        run_id: z.string(),
        after_event: z.number().int().nonnegative().optional(),
        wait_ms: z.number().int().min(0).max(30_000).optional(),
        until: z.enum(["event", "terminal"]).optional(),
        return: z.enum(["summary", "events"]).default("summary")
      }
    },
    async ({ run_id, after_event, wait_ms, until, return: returnMode }) =>
      jsonResult(
        await runManager.watch(run_id, {
          afterEvent: after_event ?? 0,
          waitMs: wait_ms ?? 0,
          until: until ?? "event",
          includeEvents: returnMode === "events"
        })
      )
  );

  server.registerTool(
    "agent_stop",
    {
      title: "Stop a supervised agent run",
      description: "Interrupt a waiting, queued or running delegation by run_id, even before the agent has exposed a session id.",
      inputSchema: { run_id: z.string() }
    },
    async ({ run_id }) => jsonResult(runManager.stop(run_id))
  );

  server.registerTool(
    "agent_list",
    {
      title: "List teammate agents",
      description: "List the agents this bridge can delegate to, with what each one is good for and which modes it accepts.",
      inputSchema: {}
    },
    async () => jsonResult(registry.list().map((a) => ({ id: a.id, description: a.description, modes: a.modes })))
  );

  server.registerTool(
    "agent_status",
    {
      title: "Agent status",
      description: "Show transport, version, available models, defaults, open sessions and run capacity — for one agent or all of them.",
      inputSchema: { agent: AgentId.optional().describe("Omit to report on every agent.") }
    },
    async ({ agent }) => {
      const targets = agent ? [registry.get(agent)] : registry.list();
      const report = {};
      for (const a of targets) {
        try {
          report[a.id] = await a.status();
        } catch (e) {
          report[a.id] = { error: e.message };
        }
      }
      return jsonResult({ bridgeCwd: defaultCwd, agents: report, runs: runManager.list({ agent, activeOnly: true }), capacity: runManager.capacity() });
    }
  );

  server.registerTool(
    "agent_cancel",
    {
      title: "Cancel an agent turn",
      description: "Cancel the current turn of a session. Only agents with long-running sessions support this.",
      inputSchema: { agent: AgentId, session_id: z.string() }
    },
    async ({ agent, session_id }) => {
      registry.get(agent).cancel(session_id);
      return textResult(`Cancel sent to ${agent} session ${session_id}`);
    }
  );
}
