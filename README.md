# acp-team

Delegate coding work to other agents from inside your own.

`acp-team` is an extensible MCP control plane for other LLMs and agents. It puts
heterogeneous transports behind one supervised interface: ask a model a question,
hand a tool-capable agent a task, and get back the same response shape.

Kimi, Codex, OpenCode and Ollama adapters are included today. They are bundled
implementations, not a closed support list: any LLM runtime or agent can join the
team through an adapter implementing the shared contract.

Transports can use ACP, a vendor CLI, a native HTTP API or another suitable
protocol. ACP Team normalizes sessions, progress, cancellation, usage and results
without requiring every LLM to speak the same protocol.

## Install

You need Node 20 or later, plus whichever agents or model runtimes you want to
use. These are examples for the bundled adapters, not the complete compatibility
surface:

    npm install -g @moonshot-ai/kimi-code    # then: kimi login
    npm install -g @openai/codex             # then: codex login
    npm install -g opencode-ai               # then: opencode auth login

Ollama is optional. Install it from https://ollama.com/download, start it, and
pull at least one model. Local API access needs no key:

    ollama pull qwen3-coder

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
`npx -y @medyll/acp-team` as a stdio server and you get the same tools.

**Only some adapters enabled?** Set `AGENT_BRIDGE_AGENTS` to their registered ids,
for example `codex,ollama`. The bridge advertises only that roster rather than
offering an agent that cannot answer.

If a CLI is not on your PATH, point `KIMI_BIN`, `CODEX_BIN` or `OPENCODE_BIN` at it.

## Verify

Ask your host to call `agent_status`. You should see each agent's version,
transport and defaults. A missing CLI is reported by name, with the fix.

## Command line

Running `acp-team` without arguments still starts the MCP stdio server. Human-facing
commands use explicit subcommands:

```sh
acp-team help
acp-team prompt "Review this project" --to codex --mode plan
acp-team chat --with kimi
acp-team prompt "Review this function" --to ollama --model qwen3-coder
acp-team configure "Optimize local model usage" --controller ollama --with qwen3-coder
acp-team agent status
acp-team usage report --period month
```

### AI-assisted configuration

`configure` runs a guided configuration interview. The controller reads the current
settings and usage, asks a small set of material questions, shows progress while it
works, validates the resulting changes, and saves a proposal. An interactive session
then asks whether to apply it; a non-interactive session never applies by default.

```sh
acp-team configure
acp-team configure "Keep reviews strong under a $30 monthly budget"
acp-team configure "Refresh model prices and optimize profiles" --with opus
acp-team configure "Same objective" --avec sonnet
acp-team configure "Use another controller" --controller codex --with gpt-5
```

`--with` (or its French alias `--avec`) selects the controller's model. Claude is the
default controller; `--controller` selects a different installed agent.

Every proposal has an id and an on-disk JSON representation:

```sh
acp-team config diff cfg_20260815...
acp-team config apply cfg_20260815...
acp-team config rollback history_20260815...
```

Applying and rolling back require interactive confirmation. Non-interactive
configuration requires both `--apply` and `--yes`. Proposal validation refuses
secret, token and API-key fields.

Configuration remains JSON because ACP Team already uses JSON for budgets, model
profiles, providers and promotions. Proposals and rollback snapshots are versioned
JSON too, avoiding a second parser and a migration to TOML without a concrete need.

### Research and install another CLI

The controller can research a CLI's official installation and authentication docs,
then present a structured dry-run:

```sh
acp-team cli research "vendor CLI" --with opus
acp-team cli install "vendor CLI" --dry-run
acp-team cli install "vendor CLI" --execute
```

Installation requires an HTTPS official source and a structured package-manager
command. Shell composition, download-and-execute pipelines and secret storage are
refused. Interactive execution always asks for confirmation; non-interactive
execution requires both `--execute` and `--yes`.

## How it works

```
                                 +--(ACP / JSON-RPC)--> ACP agents
your agent --(MCP / stdio)--> acp-team
                                 +--(CLI events)------> CLI agents
                                 +--(HTTP APIs)-------> model runtimes
                                 +--(adapter contract)-> future LLMs
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

Or ask all of them at once and read each answer with `agent_watch`:

```json
{ "agents": ["kimi", "codex", "opencode"], "prompt": "What breaks if we drop the retry wrapper?", "mode": "plan" }
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
| `agent_stop` | Stop a waiting, queued or running turn by `run_id`, even before a session id exists |
| `agent_fanout` | Send one prompt to several agents as independent runs, to compare their answers |
| `agent_ask` | Blocking compatibility API; now emits MCP progress notifications and honors request cancellation |
| `agent_list` | Which agents exist, what each is good for, which modes they accept |
| `agent_status` | Transport, version, models, defaults, open sessions and supervised runs |
| `agent_cancel` | Legacy cancellation by agent session id |
| `usage_status` | Observed tokens, reported cost, configured budget, reset period and active promotion |
| `usage_report` | Usage ledger aggregated by agent and model |
| `model_recommend` | Configured cheap, standard or premium model candidates for a task |
| `budget_check` | Check an estimated task cost before delegating it |
| `usage_compact` | Archive ledger entries past the retention window into monthly rollups |
| `usage_sync` | Refresh OpenRouter credits and model-price catalog, without storing its key |
| `ollama_status` | Ollama endpoint, version, available models and running models |
| `ollama_models` | List models available from the configured Ollama endpoint |
| `ollama_model_show` | Inspect one model's metadata and capabilities |
| `ollama_running` | List models currently loaded into memory |
| `ollama_pull` | Pull a model after explicit confirmation |
| `config_inspect` | Read configuration and provenance before proposing changes |
| `config_stage` | Validate and save a proposal without applying it |
| `config_apply` | Apply an explicitly approved proposal and create a rollback snapshot |
| `config_rollback` | Restore an explicitly approved snapshot |

For interactive delegation, prefer this control loop:

1. Call `agent_start` and keep its `runId`.
2. Call `agent_watch` with the last received event sequence in `after_event`.
3. Call `agent_stop` whenever the work should end.

Observable events include session creation, visible assistant text, plans, tool calls,
commands and file changes. Private reasoning payloads are deliberately not exposed.

### Concurrency

Each agent runs at most `AGENT_BRIDGE_MAX_CONCURRENT` turns at a time (2 by
default). Past that, a run stays `queued`, emits a `run.waiting` event and is
admitted as soon as a slot frees — a delegation is a CLI subprocess, and an
unbounded number of them competes for the same machine and the same vendor rate
limit. Limits are per agent, so a busy Codex never blocks Kimi. `agent_status`
reports the current `capacity`, and `agent_stop` works on a run that is still
waiting for its slot.

### What survives a restart

Live run state is in memory on purpose: a restarted bridge owns no agent
sessions and could not resume anything. Run *lifecycle* is journalled to
`runs.jsonl` under the data directory — queued, admitted, completed, failed,
cancelled — so the history of what was delegated remains after a crash. Agent
answers and reasoning are not journalled.

### What the confirmations do and do not do

Write-capable modes require `confirm_write`, and `yolo` requires `confirm_yolo`.
These are a deliberate speed bump, not an authorization boundary: any caller
able to invoke the tool can also send the literal string. What they buy is that
nothing reaches a write-capable mode by defaulting into it or by a model
guessing a flag. The real boundary is the sandbox each adapter requests from its
CLI, plus whatever approval the host requires before the tool runs at all.

## Modes

`mode` decides how much the agent is allowed to do.

| Mode | kimi | codex |
| --- | --- | --- |
| `plan` | ACP mode `plan`, read-only | `sandbox_mode="read-only"` |
| `default` | ACP mode `default` | `sandbox_mode="workspace-write"` |
| `auto` | ACP mode `auto` | same as `default` |
| `yolo` | ACP mode `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

When an MCP request omits `mode`, ACP Team now uses `plan` rather than an
agent-specific write-capable default. `default` and `auto` require
`confirm_write: "ALLOW_AGENT_WRITE"`. `yolo` requires
`confirm_yolo: "ALLOW_UNSANDBOXED_AGENT"`. `yolo` on Codex removes the sandbox
entirely, so keep `plan` for work that has not explicitly been authorized.

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

## Bundled adapters

This section documents the adapters shipped in this release. It does not define
or restrict the LLMs ACP Team can support.

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

**ollama** — Native Ollama HTTP API integration for local or Ollama Cloud models.
It participates in delegated prompts, supervised runs, sessions and usage
reporting, but receives no file or shell tools. Dedicated MCP tools cover model
listing, inspection, running status and confirmed pulls. Destructive model
operations are deliberately not exposed.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BRIDGE_AGENTS` | all | Comma-separated roster. Anything not listed is not advertised |
| `AGENT_BRIDGE_CWD` | process cwd | Working directory for new sessions. Leave unset; the default already follows the host session |
| `AGENT_BRIDGE_DATA_DIR` | `.acp-team/` under bridge cwd | Private local usage ledger, run journal and budget configuration |
| `AGENT_BRIDGE_MAX_CONCURRENT` | `2` | Maximum turns running at once **per agent**; further runs wait for a slot |
| `ACP_TEAM_LOG_LEVEL` | `info` | Diagnostic verbosity on stderr: `error`, `warn`, `info` or `debug` |
| `ACP_TEAM_LOG_FORMAT` | `text` | Set to `json` for one structured log object per line |
| `OPENROUTER_MANAGEMENT_KEY` | unset | Management key used only by `usage_sync` to read OpenRouter credits and catalog |
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
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local or cloud Ollama API endpoint |
| `OLLAMA_API_KEY` | unset | Bearer token for direct Ollama Cloud access; never stored by ACP Team |
| `OLLAMA_BRIDGE_MODEL` | unset | Default model for Ollama conversations; otherwise each prompt must name one |

Delegated turns can run for minutes. If one times out in Claude Code, raise
`MCP_TOOL_TIMEOUT` (milliseconds).

### Usage and budget data

The first `usage_status` call creates editable JSON files in the data directory:
`budgets.json` (period and per-run limits), `models.json` (the short list for
`cheap`, `standard` and `premium` work), `providers.json` (billing metadata)
and `promotions.json` (temporary offers with an expiry). Completed agent calls
append observed metrics to `usage-ledger.jsonl`.

`usage_sync` saves the OpenRouter balance in `providers.json` and a normalized
catalogue with price, context and capability data in `model-catalog.json`. It
never writes the management key. OpenCode's `stats` command currently has no
machine-readable output, so its cost data remains agent-reported until its CLI
or server exposes a stable JSON format.

Provider quotas that cannot be queried are deliberately reported as `unknown`.
ACP Team keeps reported costs distinct from calculated prices and estimates.

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
