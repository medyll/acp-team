import { createInterface } from "node:readline/promises";

export function createTerminal({ input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  let reader;
  const rl = () => (reader ??= createInterface({ input, output }));
  return {
    interactive,
    log(message = "") { output.write(`${message}\n`); },
    warn(message) { error.write(`${message}\n`); },
    phase(message) { error.write(`[acp-team] ${message}\n`); },
    async ask(message, fallback = "") {
      if (!interactive) return fallback;
      const suffix = fallback ? ` [${fallback}]` : "";
      return (await rl().question(`${message}${suffix}: `)).trim() || fallback;
    },
    async confirm(message, fallback = false) {
      if (!interactive) return fallback;
      const answer = (await rl().question(`${message} ${fallback ? "[O/n]" : "[o/N]"} `)).trim().toLowerCase();
      if (!answer) return fallback;
      return ["o", "oui", "y", "yes"].includes(answer);
    },
    close() { reader?.close(); }
  };
}

export async function withProgress(terminal, label, operation) {
  const started = Date.now();
  terminal.phase(`${label}…`);
  const timer = setInterval(() => terminal.phase(`${label} — ${Math.round((Date.now() - started) / 1000)} s`), 5000);
  timer.unref?.();
  try {
    const result = await operation();
    terminal.phase(`${label} — terminé`);
    return result;
  } finally {
    clearInterval(timer);
  }
}
