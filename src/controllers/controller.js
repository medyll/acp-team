import { spawn } from "node:child_process";
import { appendLimited, deadlineSignal } from "../resilience.js";

const CONTROLLER_IDS = ["claude", "codex", "kimi", "opencode", "ollama"];

export function parseWith(value, defaultController = "claude") {
  if (!value) return { controller: defaultController, model: null };
  if (value.includes(":")) {
    const [controller, ...model] = value.split(":");
    if (CONTROLLER_IDS.includes(controller) && model.join(":")) return { controller, model: model.join(":") };
  }
  if (CONTROLLER_IDS.includes(value)) return { controller: value, model: null };
  return { controller: defaultController, model: value };
}

export function createController({ id = "claude", model, registry, cwd = process.cwd(), spawnImpl = spawn, onEvent = () => {}, timeoutMs = 3 * 60_000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  if (id === "claude") return createClaudeController({ model, cwd, spawnImpl, onEvent, timeoutMs, maxOutputBytes });
  if (!registry) throw new Error(`Controller ${id} requires the agent registry`);
  const adapter = registry.get(id);
  return {
    id,
    model,
    async prompt(text) {
      const deadline = deadlineSignal(undefined, timeoutMs, `${id} controller`);
      try {
        const result = await adapter.ask({ prompt: text, cwd, model, mode: "plan", newSession: true, onEvent, signal: deadline.signal });
        return result.text;
      } finally {
        deadline.cleanup();
      }
    }
  };
}

export async function promptForJson(controller, prompt) {
  const text = await controller.prompt(`${prompt}\n\nReturn only one valid JSON object. Do not use Markdown fences.`);
  return extractJsonObject(text);
}

export function extractJsonObject(text) {
  if (typeof text !== "string") throw new Error("The controller returned no text");
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* handled below */ }
    }
    throw new Error(`The controller did not return valid JSON: ${trimmed.slice(0, 180)}`);
  }
}

function createClaudeController({ model, cwd, spawnImpl, onEvent, timeoutMs, maxOutputBytes }) {
  if (model && !/^[a-zA-Z0-9._:/-]+$/.test(model)) throw new Error("Invalid Claude model name");
  return {
    id: "claude",
    model,
    prompt(text) {
      // On Windows the CLI is a .cmd shim, which only runs through cmd.exe — and
      // cmd.exe takes one command *string*, so args are joined rather than passed
      // as a vector. Two rules keep that safe and must stay true: the model name
      // is validated against a strict character class above, and the prompt is
      // never an argument — it is written to stdin below.
      const executable = process.env.CLAUDE_BIN || (process.platform === "win32" ? "claude.cmd" : "claude");
      const claudeArgs = ["-p", "--output-format", "json", "--permission-mode", "plan", "--max-turns", "8"];
      if (model) claudeArgs.push("--model", model);
      const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
      const command = isShim ? process.env.ComSpec || "cmd.exe" : executable;
      const args = isShim ? ["/d", "/s", "/c", [quoteCmd(executable), ...claudeArgs].join(" ")] : claudeArgs;
      onEvent({ type: "controller.started", controller: "claude", model: model ?? "default" });
      return new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const capture = (stream, label) => (data) => {
          try {
            if (stream === "stdout") stdout = appendLimited(stdout, data, maxOutputBytes, label);
            else stderr = appendLimited(stderr, data, maxOutputBytes, label);
          } catch (error) {
            child.kill();
            finish(() => reject(error));
          }
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(() => reject(new Error(`Claude controller timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on("data", capture("stdout", "Claude stdout"));
        child.stderr.on("data", capture("stderr", "Claude stderr"));
        child.on("error", (error) => {
          finish(() => {
            if (error.code === "ENOENT") reject(new Error(`Claude CLI not found (tried "${executable}"). Install it, authenticate, or choose another controller with --controller.`));
            else reject(error);
          });
        });
        child.on("close", (code) => {
          finish(() => {
            if (code !== 0) return reject(new Error(`Claude CLI exited ${code}: ${stderr.trim() || "no diagnostic"}`));
            try {
              const envelope = JSON.parse(stdout);
              onEvent({ type: "controller.completed" });
              resolve(envelope.result ?? envelope.text ?? stdout);
            } catch {
              resolve(stdout);
            }
          });
        });
        child.stdin.end(text);
      });
    }
  };
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
