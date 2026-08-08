# acp-team

One MCP server that lets Claude Code hand work to other coding agents through a
single uniform interface. Each agent gets an adapter; the transport underneath is
whatever that agent actually speaks.

```
                                  +--(ACP / JSON-RPC over stdio)--> [ kimi acp ]
[ Claude Code ] --(MCP/stdio)--> [ acp-team ]
                                  +--(`codex exec --json`, JSONL)--> [ codex ]
```

Claude Code stays an MCP host. Agents run their own tools — file reads/writes,
shell — inside the working directory the bridge hands them.

## Tools

| Tool | What it does |
| --- | --- |
| `agent_ask` | Delegate a prompt. Params: `agent`, `prompt`, `cwd`, `session_id`, `new_session`, `model`, `mode`, `thinking`, `options`, `include_thoughts`. |
| `agent_list` | Which agents exist, what each is good for, which modes they accept. |
| `agent_status` | Transport, version, models, defaults, open sessions — one agent or all. |
| `agent_cancel` | Cancel a running turn (agents with long-lived sessions only). |

Every agent returns the same shape: final text, a summary of the tools it ran,
optional reasoning, plus its session id.

Sessions are kept **per agent per working directory**, so repeated `agent_ask`
calls continue the same conversation. `session_id` targets an explicit one,
`new_session: true` starts fresh.

## Agents

### kimi — Kimi Code CLI over ACP

Verified against Kimi Code CLI `0.33.0`, ACP protocol `1`.
Models: `kimi-code/kimi-for-coding` (K2.7), `kimi-code/kimi-for-coding-highspeed`,
`kimi-code/k3-256k`, `kimi-code/k3`.

One long-lived `kimi acp` process backs every session; sessions are real ACP
sessions, so state lives inside the agent. Supports `thinking` and `agent_cancel`.

Requires `kimi` on PATH and logged in (`kimi login`). Auth is OAuth-based and
lives inside Kimi, not in ACP — the bridge never sees a credential. If the token
expires, `session/new` fails and you re-run `kimi login`.

### codex — OpenAI Codex CLI via `codex exec`

Verified against Codex CLI `0.145.0`. Codex has **no ACP support** (no `codex acp`
subcommand), so the adapter drives `codex exec --json` — one process per turn,
JSONL events on stdout — and resumes conversations by thread id.

Consequences of that transport:
- No `agent_cancel`; each turn is a short-lived process.
- No `thinking` parameter.
- `mode` selects a sandbox policy rather than an approval policy, because
  `exec` is non-interactive and nobody is there to approve anything.

## Choosing a model and its settings

Three levels, most local first.

**Per call** — `model`, `mode`, `thinking` on `agent_ask`. A model set this way
sticks to the session, so later turns in the same cwd keep it.

```json
{ "agent": "kimi", "prompt": "...", "model": "kimi-code/k3", "thinking": "high" }
{ "agent": "codex", "prompt": "...", "model": "gpt-5.6-sol" }
```

**Anything else the agent supports** — the free-form `options` map:

```json
{ "agent": "codex", "prompt": "...", "options": { "model_reasoning_effort": "high", "model_verbosity": "low" } }
{ "agent": "kimi",  "prompt": "...", "options": { "thinking": "max" } }
```

For codex these become `-c key=value` overrides, the same keys `~/.codex/config.toml`
accepts; values are TOML, and the adapter quotes strings for you. For kimi they
become `session/set_config_option` calls, validated against the option list that
session currently advertises — a bad value is refused before it is sent, with the
legal values in the message.

Kimi's `thinking` list depends on the selected model, so `options` are applied
after the model, not before.

**Defaults** — `KIMI_BRIDGE_MODEL`, `CODEX_BRIDGE_MODEL` and friends in `.mcp.json`.

**Agent's own config** — `~/.codex/config.toml`, Kimi's `config.toml`. Whatever the
bridge does not override is inherited from there.

## Modes

| Mode | kimi | codex |
| --- | --- | --- |
| `plan` | ACP mode `plan`, read-only | `-c sandbox_mode="read-only"` |
| `default` | ACP mode `default` | `-c sandbox_mode="workspace-write"` |
| `auto` | ACP mode `auto` | same as `default` |
| `yolo` | ACP mode `yolo` | `--dangerously-bypass-approvals-and-sandbox` |

`yolo` on codex removes the sandbox entirely. Use `plan` for anything you have not
decided to let an agent execute.

## Install

```bash
npm install
```

`kimi` and `codex` must be on PATH and authenticated. Override binaries with
`KIMI_BIN` / `CODEX_BIN`.

## Register with Claude Code

`.mcp.json` in this repo already declares the server. Elsewhere:

```bash
claude mcp add acp-team -- node D:\development\acp-team\src\mcp-server.js
```

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `AGENT_BRIDGE_CWD` | process cwd | Working directory given to new sessions |
| `KIMI_BIN` | `kimi.exe` / `kimi` | Kimi binary |
| `KIMI_BRIDGE_MODEL` | agent default (K2.7 Coding) | Model for new kimi sessions |
| `KIMI_BRIDGE_MODE` | `auto` | Default kimi mode |
| `KIMI_BRIDGE_PERMISSION` | `allow` | How `session/request_permission` is answered: `allow` or `deny` |
| `CODEX_BIN` | `codex.exe` / `codex` | Codex binary |
| `CODEX_BRIDGE_MODEL` | codex default | Model for codex turns |
| `CODEX_BRIDGE_MODE` | `default` | Default codex sandbox mode |
| `CODEX_BRIDGE_SKIP_GIT_CHECK` | `true` | Pass `--skip-git-repo-check`; set `false` to let codex refuse non-git directories |

## Layout

```
src/
  mcp-server.js            MCP surface: the four agent_* tools
  mcp-smoke-test.js        Full chain test, every agent
  agents/
    agent.js               Shared adapter contract + mode vocabulary
    registry.js            Builds adapters, one line per agent
    kimi/                  ACP client, adapter, transport-level test
    codex/                 exec adapter, transport-level test
```

Adding an agent: new folder under `src/agents/`, implement the contract in
`agent.js`, one line in `registry.js`.

## Tests

```bash
npm test
```

Full chain, both agents. The others hit a single layer directly, no MCP:

| Script | Covers |
| --- | --- |
| `npm run test:kimi` | ACP client -> `kimi acp`: handshake, session, one prompt |
| `npm run test:kimi:adapter` | Regression: model/mode/thinking overrides on a session reused by cwd |
| `npm run test:codex` | `codex exec` adapter, including that thread resume preserves state |

## Transport gotchas found while building this

- ACP `session/set_config_option` params are `{ sessionId, configId, type: "id"|"boolean", value }`
  — not `optionId`. Wrong shape returns `Invalid params (-32602)`.
- Kimi 0.33.0 answers `Internal error (-32603)` when a config option or mode is set
  to the value it **already holds**, through either `session/set_mode` or
  `session/set_config_option`. The client tracks current values and skips no-op sets.
- Legal `thinking` values depend on the selected model: `kimi-code/k3` accepts
  `low|high|max|on`, `kimi-code/kimi-for-coding` accepts only `on`. The client
  tracks the allowed list from each response and rejects early with it.
- ACP `session/prompt` resolves with a `stopReason`; the actual output arrives
  beforehand as `session/update` notifications.
- The bridge declares `fs` and `terminal` client capabilities as **false**, so Kimi
  uses its own tools rather than calling back into the bridge. Any other incoming
  agent request gets `-32601`.
- `codex exec resume` accepts a far smaller flag set than `codex exec`: no
  `--sandbox`, no `--cd`, no `--color`. The adapter uses only flags both accept.
- `codex exec` reads extra prompt material from stdin — the adapter closes it
  immediately or the process hangs.
- Agents cold-start well past the MCP SDK's 60s default request timeout (the smoke
  test raises it to 300s). If a delegated turn times out inside Claude Code, raise
  its tool timeout via `MCP_TOOL_TIMEOUT` (milliseconds).
