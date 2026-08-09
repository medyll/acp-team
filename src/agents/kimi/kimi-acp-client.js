import { spawn } from "node:child_process";
import readline from "node:readline";

const KIMI_BIN = process.env.KIMI_BIN || (process.platform === "win32" ? "kimi.exe" : "kimi");
const PROTOCOL_VERSION = 1;

/**
 * Minimal ACP client speaking JSON-RPC 2.0 over stdio to `kimi acp`.
 *
 * Only the client side we actually need is implemented:
 *  - outgoing: initialize, session/new, session/prompt, session/cancel, session/set_mode
 *  - incoming: session/update notifications, session/request_permission requests
 *
 * File system and terminal capabilities are declared as unsupported, so Kimi
 * uses its own tools instead of asking the bridge to read/write files.
 */
export class KimiAcpClient {
  constructor({ permissionPolicy = "allow", onLog = () => {} } = {}) {
    this.permissionPolicy = permissionPolicy;
    this.onLog = onLog;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    /** sessionId -> { collectors: Set<fn> } */
    this.sessions = new Map();
    this.initResult = null;
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    this.proc = spawn(KIMI_BIN, ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
    // A missing binary surfaces here, not as a throw; without this the caller
    // would only see a request that never resolves.
    this.proc.on("error", (e) => {
      const err =
        e.code === "ENOENT"
          ? new Error(
              `Kimi CLI not found (tried "${KIMI_BIN}"). Install it and run \`kimi login\`, or set KIMI_BIN to its path.`
            )
          : e;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.proc = null;
      this.startPromise = null;
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`kimi acp exited (code=${code} signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.sessions.clear();
      this.proc = null;
      this.startPromise = null;
      this.initResult = null;
    });
    this.proc.stderr.on("data", (d) => this.onLog(`kimi stderr: ${d.toString().trim()}`));

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.#onLine(line));

    this.initResult = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "kimi-acp-bridge", version: "1.0.0" }
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
      const wanted =
        this.permissionPolicy === "deny"
          ? ["reject_always", "reject_once"]
          : ["allow_always", "allow_once"];
      const picked = wanted.map((k) => options.find((o) => o.kind === k)).find(Boolean) ?? options[0];
      this.onLog(`permission ${this.permissionPolicy}: ${picked?.optionId ?? "none"}`);
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
    if (!this.proc) throw new Error("kimi acp is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
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
    // Kimi 0.33.0 answers -32603 when a mode is re-set to the value it already
    // holds, so a no-op set has to be skipped rather than sent.
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
   * Returns { stopReason, text, thoughts, toolCalls }.
   */
  async prompt(sessionId, text, { onUpdate } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const out = { text: "", thoughts: "", toolCalls: [] };
    const collect = (update) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          out.text += contentText(update.content);
          break;
        case "agent_thought_chunk":
          out.thoughts += contentText(update.content);
          break;
        case "tool_call":
        case "tool_call_update": {
          const id = update.toolCallId;
          const existing = out.toolCalls.find((t) => t.toolCallId === id);
          if (existing) Object.assign(existing, update);
          else out.toolCalls.push({ ...update });
          break;
        }
        default:
          break;
      }
      onUpdate?.(update);
    };

    session.collectors.add(collect);
    try {
      const res = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }]
      });
      return { stopReason: res?.stopReason ?? "end_turn", ...out };
    } finally {
      session.collectors.delete(collect);
    }
  }

  stop() {
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
