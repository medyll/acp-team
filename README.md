# acp-team

Delegate coding work to other agents from inside your own.

`acp-team` is an MCP server that puts Kimi, Codex and OpenCode behind one tool. Ask any
of them a question, hand any of them a task, and get back the same shape of
answer. They run in your project, with their own file and shell tools, and report
what they did.

The transports differ underneath and you never have to care: Kimi and OpenCode
speak the Agent Client Protocol, while Codex is driven through its CLI.

## Install

You need Node 20 or later, plus the agents themselves. Install whichever you
want to use and log in:

    npm install -g @moonshot-ai/kimi-code    # then: kimi login
    npm install -g @openai/codex             # then: codex login
    npm install -g opencode-ai               # then: opencode auth login

The bridge itself needs no installation. Register it with your MCP host and
`npx` fetches it on first use.

**Claude Code, every project.** This is the common case:

    claude mcp add acp-team -s user -- npx -y @medyll/acp-team

**Claude Code, one project.** Commit a `.mcp.json` at the project root so the
whole team gets it:

```json
{
  "mcpServers": {
    "acp-team": {
      "command": "npx",
      "args": ["-y", "@medyll/acp-team"]
    }
  }
}
```

**Codex.** It is an MCP host too:

    codex mcp add acp-team -- npx -y @medyll/acp-team

**Any other MCP host.** Nothing here is host specific. Run
`npx -y @medyll/acp-team` as a stdio server and you get the same seven tools.

**Only one agent installed?** Set `AGENT_BRIDGE_AGENTS=codex` (or `kimi`, or
`opencode`) in the
server's environment. The bridge then advertises only that one, rather than
offering an agent that cannot answer.

If a CLI is not on your PATH, point `KIMI_BIN`, `CODEX_BIN` or `OPENCODE_BIN` at it.

## Verify

Ask your host to call `agent_status`. You should see each agent's version,
transport and defaults. A missing CLI is reported by name, with the fix.

## How it works

```
                                 +--(ACP / JSON-RPC over stdio)--> kimi acp
your agent --(MCP / stdio)--> acp-team
                                 +--(ACP / JSON-RPC over stdio)--> opencode acp
                                 +--(codex exec --json, JSONL)-----> codex
```

Your host stays the host. The bridge is the client for whatever protocol each
agent speaks, and exposes them all as ordinary MCP tools.

The bridge works in the project you are currently in. An MCP host starts one
server per session with that session's working directory, and the bridge takes
its default from there. Nothing to configure per project, no paths to update.

Conversations are kept per agent per working directory, so calling `agent_ask`
twice continues the same conversation rather than starting over. Pass
`session_id` to target a specific one, or `new_session: true` to start fresh.
Since sessions are keyed by directory, one bridge can drive several projects at
once.

Every agent returns the same thing: the final answer, a summary of the tools it
ran, its session id, and optionally its reasoning.

## Usage

Get a second opinion on code you just wrote:

```json
{ "agent": "codex", "prompt": "Review src/auth/session.ts for real bugs, not style. Be concise.", "mode": "plan" }
```

`mode: "plan"` is read-only. Use it whenever you want an opinion rather than an
edit.

Hand off a self-contained task and let the agent do the work:

```json
{ "agent": "codex", "prompt": "Add a --dry-run flag to the migrate command, with a test.", "mode": "default" }
```

Put a long-context model on a large question:

```json
{ "agent": "kimi", "prompt": "Trace how a request flows from the router to the database and note anything surprising.", "model": "kimi-code/k3-256k", "thinking": "high" }
```

Ask both and compare. Their transports are independent, so the two calls do not
interfere:

```json
{ "agent": "kimi",  "prompt": "What breaks if we drop the retry wrapper?", "mode": "plan" }
{ "agent": "codex", "prompt": "What breaks if we drop the retry wrapper?", "mode": "plan" }
```

Work on another project without leaving this one:

```json
{ "agent": "codex", "prompt": "Does the public API still match the docs?", "cwd": "/work/other-project", "mode": "plan" }
```

Continue an earlier conversation explicitly:

```json
{ "agent": "kimi", "prompt": "Now apply the second suggestion.", "session_id": "session_4fcf32d3-…" }
```

## Tools

| Tool | Purpose |
| --- | --- |
| `agent_start` | Start a supervised turn and return a `run_id` immediately |
| `agent_watch` | Read status and new events; supports bounded long-polling with `after_event` and `wait_ms` |
| `agent_stop` | Stop a queued or running turn by `run_id`, even before a session id exists |
| `agent_ask` | Blocking compatibility API; now emits MCP progress notifications and honors request cancellation |
| `agent_list` | Which agents exist, what each is good for, which modes they accept |
| `agent_status` | Transport, version, models, defaults, open sessions and supervised runs |
| `agent_cancel` | Legacy cancellation by agent session id |

For interactive delegation, prefer this control loop:

1. Call `agent_start` and keep its `runId`.
2. Call `agent_watch` with the last received event sequence in `after_event`.
3. Call `agent_stop` whenever the work should end.

Observable events include session creation, visible assistant text, plans, tool calls,
commands and file changes. Private reasoning payloads are deliberately not exposed.

## Modes

`mode` decides how much the agent is allowed to do.

| Mode | kimi | codex |
| --- | --- | --- |
| `plan` | ACP mode `plan`, read-only | `sandbox_mode="read-only"` |
| `default` | ACP mode `default` | `sandbox_mode="workspace-write"` |
| `auto` | ACP mode `auto` | same as `default` |
| `yolo` | ACP mode `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

`yolo` on Codex removes the sandbox entirely. Prefer `plan` for anything you
have not decided to let an agent execute.

## Models and settings

Set `model`, `mode` and `thinking` per call. A model set this way sticks to the
session, so later turns keep it.

```json
{ "agent": "kimi",  "prompt": "…", "model": "kimi-code/k3", "thinking": "high" }
{ "agent": "codex", "prompt": "…", "model": "gpt-5.6-sol" }
```

Anything else the agent supports goes through the free-form `options` map:

```json
{ "agent": "codex", "prompt": "…", "options": { "model_reasoning_effort": "high", "model_verbosity": "low" } }
{ "agent": "kimi",  "prompt": "…", "options": { "thinking": "max" } }
```

For Codex these become `-c key=value` overrides, the same keys
`~/.codex/config.toml` accepts. For Kimi they become session config options,
validated against what that session currently advertises: a bad value is refused
before it is sent, and the message lists the legal ones.

Kimi's legal `thinking` values depend on the selected model, so `options` are
applied after the model, never before.

Defaults come from the environment, and anything the bridge does not override is
inherited from the agent's own configuration.

## Agents

**kimi** — Kimi Code CLI over ACP, verified against `0.33.0`, protocol `1`.
Models: `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`,
`kimi-code/k3-256k`, `kimi-code/k3`. One long-lived `kimi acp` process backs
every session, so conversation state lives inside the agent. Supports `thinking`
and `agent_cancel`. Authentication is Kimi's own OAuth: the bridge never sees a
credential, and an expired token means running `kimi login` again.

**codex** — OpenAI Codex CLI, verified against `0.145.0`. Codex has no ACP
support, so the adapter drives `codex exec --json`, one process per turn, and
resumes conversations by thread id. Consequently there is no `thinking`
parameter, and `mode` selects a sandbox policy rather than an approval policy,
because `exec` is non-interactive and nobody is there to approve anything.

**opencode** — OpenCode CLI over native ACP, verified against `1.17.11`,
protocol `1`. One long-lived `opencode acp` process backs its sessions. Bridge
modes `default`, `auto` and `yolo` map to OpenCode's `build` mode; `plan` maps
to `plan`. Models come from the providers configured by `opencode auth login`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BRIDGE_AGENTS` | all | Comma-separated roster. Anything not listed is not advertised |
| `AGENT_BRIDGE_CWD` | process cwd | Working directory for new sessions. Leave unset; the default already follows the host session |
| `KIMI_BIN` | `kimi` | Kimi binary |
| `KIMI_BRIDGE_MODEL` | agent default | Model for new Kimi sessions |
| `KIMI_BRIDGE_MODE` | `auto` | Default Kimi mode |
| `KIMI_BRIDGE_PERMISSION` | `allow` | How permission requests are answered: `allow` or `deny` |
| `CODEX_BIN` | `codex` | Codex binary |
| `CODEX_BRIDGE_MODEL` | Codex default | Model for Codex turns |
| `CODEX_BRIDGE_MODE` | `default` | Default Codex sandbox mode |
| `CODEX_BRIDGE_SKIP_GIT_CHECK` | `true` | Pass `--skip-git-repo-check`; set `false` to let Codex refuse non-git directories |
| `OPENCODE_BIN` | `opencode` (`opencode.cmd` on Windows) | OpenCode binary |
| `OPENCODE_BRIDGE_MODEL` | OpenCode default | Model for new OpenCode sessions |
| `OPENCODE_BRIDGE_MODE` | `default` | Default bridge mode (`plan` or a mode mapped to OpenCode `build`) |
| `OPENCODE_BRIDGE_PERMISSION` | `allow` | How ACP permission requests are answered: `allow` or `deny` |

Delegated turns can run for minutes. If one times out in Claude Code, raise
`MCP_TOOL_TIMEOUT` (milliseconds).

## Development

```
src/
  mcp-server.js          MCP surface: the seven agent_* tools
  mcp-smoke-test.js      Full chain, every agent
  agents/
    agent.js             Shared adapter contract and mode vocabulary
    registry.js          Builds adapters, one entry per agent
    session-queue.js     Serializes turns within a session
    acp/                 Shared ACP transport and adapter
    kimi/                Kimi profile and tests
    opencode/            OpenCode profile and tests
    codex/               exec adapter, tests
```

Adding an agent means a new folder under `src/agents/`, an object satisfying the
contract in `agent.js`, and one entry in `registry.js`.

`npm test` runs the unit tests, which need no agent installed. The smoke tests
below talk to the real CLIs and spend real tokens:

| Script | Covers |
| --- | --- |
| `npm run test:smoke` | Full chain through MCP, every agent |
| `npm run test:smoke:kimi` | ACP client against `kimi acp`: handshake, session, prompt |
| `npm run test:smoke:kimi-adapter` | Overrides applied to a session reused by cwd |
| `npm run test:smoke:codex` | Codex adapter, including that thread resume preserves state |
| `npm run test:smoke:opencode` | ACP client against `opencode acp`: handshake, session, prompt |

`npm run test:smoke -- codex` restricts the full-chain run to one agent.

## Notes on the transports

These cost time to discover and are not in either agent's documentation.

Kimi answers `Internal error (-32603)` when a config option or mode is set to the
value it already holds, through either `session/set_mode` or
`session/set_config_option`. The client tracks current values and skips no-op
sets.

Kimi's legal `thinking` values are model-dependent: `kimi-code/k3` accepts
`low`, `high`, `max` and `on`, while `kimi-code/kimi-for-coding` accepts far
fewer. The client tracks the allowed list from each response.

ACP's `session/set_config_option` takes `{ sessionId, configId, type, value }`.
Sending `optionId` instead returns `Invalid params (-32602)`.

The bridge declares the `fs` and `terminal` client capabilities as false, so Kimi
uses its own tools rather than calling back into the bridge.

`codex exec resume` accepts a much smaller flag set than `codex exec`: no
`--sandbox`, no `--cd`, no `--color`. The adapter uses only flags both accept,
setting the sandbox through `-c` and the working directory through the spawn
options.

`codex exec` reads additional prompt material from stdin, so the adapter closes
it immediately or the process waits forever.

## License

MIT
