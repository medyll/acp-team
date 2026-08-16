import { spawn } from "node:child_process";
import readline from "node:readline";
import { appendLimited } from "../../resilience.js";

const PROTOCOL_VERSION = 1;

/**
 * Minimal configurable ACP client speaking JSON-RPC 2.0 over stdio.
 *
 * Only the client side we actually need is implemented:
 *  - outgoing: initialize, session/new, session/prompt, session/cancel, session/set_mode
 *  - incoming: session/update notifications, session/request_permission requests
 *
 * File system and terminal capabilities are declared as unsupported, so the
 * agent uses its own tools instead of asking the bridge to read/write files.
 */
export class AcpClient {
  constructor({
    command,
    displayCommand = command,
    args = ["acp"],
    shell = false,
    agentLabel = "ACP agent",
    clientName = "acp-team-bridge",
    missingHint = "Install the agent CLI or configure its binary path.",
    permissionPolicy = "allow",
    requestTimeoutMs = 10 * 60_000,
    maxOutputBytes = 4 * 1024 * 1024,
    onLog = () => {}
  } = {}) {
    if (!command) throw new Error("ACP client command is required");
    this.command = command;
    this.displayCommand = displayCommand;
    this.args = args;
    this.shell = shell;
    this.agentLabel = agentLabel;
    this.clientName = clientName;
    this.missingHint = missingHint;
    this.permissionPolicy = permissionPolicy;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.onLog = onLog;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    /** sessionId -> { collectors: Set<fn> } */
    this.sessions = new Map();
    this.initResult = null;
    this.startPromise = null;
    this.stopping = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    this.stopping = false;
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: this.shell,
      windowsHide: true
    });
    // A missing binary surfaces here, not as a throw; without this the caller
    // would only see a request that never resolves.
    this.proc.on("error", (e) => {
      const err =
        e.code === "ENOENT"
          ? new Error(`${this.agentLabel} CLI not found (tried "${this.displayCommand}"). ${this.missingHint}`)
          : e;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
      this.proc = null;
      this.startPromise = null;
    });
    this.proc.on("exit", (code, signal) => {
      const hint = this.initResult ? "" : ` ${this.missingHint}`;
      const err = new Error(`${this.agentLabel} ACP exited (code=${code} signal=${signal}).${hint}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
      this.sessions.clear();
      this.proc = null;
      this.startPromise = null;
      this.initResult = null;
    });
    this.proc.stderr.on("data", (d) => {
      if (!this.stopping) this.onLog(`${this.agentLabel} stderr: ${d.toString().slice(0, 8_192).trim()}`);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.#onLine(line));

    this.initResult = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: this.clientName, version: "1.0.0" }
    });
    return this.initResult;
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON chatter on stdout
    }

    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else entry.resolve(msg.result);
      return;
    }

    // Request from the agent -> we must answer
    if (msg.method && msg.id !== undefined) {
      this.#handleAgentRequest(msg);
      return;
    }

    // Notification from the agent
    if (msg.method === "session/update") {
      const sid = msg.params?.sessionId;
      const session = this.sessions.get(sid);
      if (session) for (const fn of session.collectors) fn(msg.params.update);
    }
  }

  #handleAgentRequest(msg) {
    if (msg.method === "session/request_permission") {
      const options = msg.params?.options ?? [];
      const sessionMode = this.currentConfig(msg.params?.sessionId, "mode");
      const effectivePolicy = !sessionMode || sessionMode === "plan" ? "deny" : this.permissionPolicy;
      const wanted =
        effectivePolicy === "deny"
          ? ["reject_always", "reject_once"]
          : ["allow_always", "allow_once"];
      const picked = wanted.map((k) => options.find((o) => o.kind === k)).find(Boolean) ?? options[0];
      this.onLog(`permission ${effectivePolicy}: ${picked?.optionId ?? "none"}`);
      this.#send({
        jsonrpc: "2.0",
        id: msg.id,
        result: picked
          ? { outcome: { outcome: "selected", optionId: picked.optionId } }
          : { outcome: { outcome: "cancelled" } }
      });
      return;
    }

    // Anything we did not opt into (fs/*, terminal/*) is refused explicitly.
    this.#send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not supported by bridge: ${msg.method}` }
    });
  }

  #send(obj) {
    if (!this.proc) throw new Error(`${this.agentLabel} ACP is not running`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.proc?.kill?.();
        reject(new Error(`${this.agentLabel} ACP request ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async newSession({ cwd, mcpServers = [], model, mode, thinking } = {}) {
    await this.start();
    const res = await this.request("session/new", {
      cwd: cwd || process.cwd(),
      mcpServers
    });
    this.sessions.set(res.sessionId, { collectors: new Set(), cwd, configOptions: [] });
    this.#trackConfig(res.sessionId, res.configOptions);
    // Order matters: the set of legal `thinking` values depends on the model.
    if (model) await this.setConfigOption(res.sessionId, "model", model);
    if (thinking) await this.setConfigOption(res.sessionId, "thinking", thinking);
    if (mode) await this.setMode(res.sessionId, mode);
    return res;
  }

  /** Remember the current value and legal values of every config option. */
  #trackConfig(sessionId, configOptions) {
    const session = this.sessions.get(sessionId);
    if (!session || !configOptions) return;
    session.configOptions = configOptions;
    session.config = Object.fromEntries(configOptions.map((o) => [o.id, o.currentValue]));
    session.allowed = Object.fromEntries(
      configOptions.map((o) => [o.id, (o.options ?? []).map((v) => v.value)])
    );
  }

  /** Current value of a config option, or undefined if the session is unknown. */
  currentConfig(sessionId, configId) {
    return this.sessions.get(sessionId)?.config?.[configId];
  }

  async setMode(sessionId, modeId) {
    // Some ACP agents reject setting a mode to its current value, so skip no-ops.
    if (this.currentConfig(sessionId, "mode") === modeId) return { skipped: true };
    const res = await this.request("session/set_mode", { sessionId, modeId });
    const session = this.sessions.get(sessionId);
    if (session?.config) session.config.mode = modeId;
    return res;
  }

  async setConfigOption(sessionId, configId, value) {
    // Same no-op guard as setMode.
    if (this.currentConfig(sessionId, configId) === value) return { skipped: true };

    // Legal values are session- and model-dependent (`thinking` shrinks to
    // ["on"] on some models), so reject early with the actual list.
    const allowed = this.sessions.get(sessionId)?.allowed?.[configId];
    if (allowed?.length && !allowed.includes(value)) {
      throw new Error(`Invalid ${configId} "${value}" for this session. Allowed: ${allowed.join(", ")}`);
    }

    const res = await this.request("session/set_config_option", {
      sessionId,
      configId,
      type: typeof value === "boolean" ? "boolean" : "id",
      value
    });
    this.#trackConfig(sessionId, res?.configOptions);
    return res;
  }

  cancel(sessionId) {
    this.notify("session/cancel", { sessionId });
  }

  /**
   * Send a prompt and collect everything the agent streams back until it stops.
   * Returns { stopReason, text, thoughts, toolCalls, usage } when the ACP
   * agent implements the optional session usage extension.
   */
  async prompt(sessionId, text, { onUpdate } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const out = { text: "", thoughts: "", toolCalls: [] };
    let outputError;
    const collect = (update) => {
      try {
        switch (update.sessionUpdate) {
          case "agent_message_chunk":
            out.text = appendLimited(out.text, contentText(update.content), this.maxOutputBytes, "ACP agent message");
            break;
          case "agent_thought_chunk":
            out.thoughts = appendLimited(out.thoughts, contentText(update.content), this.maxOutputBytes, "ACP agent thoughts");
            break;
          case "tool_call":
          case "tool_call_update": {
            const id = update.toolCallId;
            const existing = out.toolCalls.find((t) => t.toolCallId === id);
            if (existing) Object.assign(existing, update);
            else if (out.toolCalls.length < 1_000) out.toolCalls.push({ ...update });
            break;
          }
          default:
            break;
        }
      } catch (error) {
        outputError = error;
        this.cancel(sessionId);
        return;
      }
      onUpdate?.(update);
    };

    session.collectors.add(collect);
    try {
      const res = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }]
      });
      if (outputError) throw outputError;
      return { stopReason: res?.stopReason ?? "end_turn", usage: res?.usage, ...out };
    } finally {
      session.collectors.delete(collect);
    }
  }

  stop() {
    this.stopping = true;
    this.proc?.kill();
  }
}

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content.type === "text") return content.text ?? "";
  return "";
}
