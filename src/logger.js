const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = "info";

/**
 * Diagnostics always go to stderr: stdout is the MCP stdio transport and any
 * stray byte there corrupts the protocol stream.
 *
 * ACP_TEAM_LOG_LEVEL selects verbosity, ACP_TEAM_LOG_FORMAT=json emits one JSON
 * object per line for hosts that collect logs.
 */
export function createLogger({
  name = "acp-team",
  level = process.env.ACP_TEAM_LOG_LEVEL || DEFAULT_LEVEL,
  format = process.env.ACP_TEAM_LOG_FORMAT || "text",
  write = (line) => process.stderr.write(line),
  now = () => new Date()
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS[DEFAULT_LEVEL];
  const asJson = format === "json";

  function emit(severity, message, fields) {
    if (LEVELS[severity] > threshold) return;
    const at = now().toISOString();
    if (asJson) {
      write(`${JSON.stringify({ at, level: severity, name, message, ...fields })}\n`);
      return;
    }
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    write(`[${name}] ${severity}: ${message}${suffix}\n`);
  }

  const logger = {
    level,
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    child: (childName) => createLogger({ name: `${name}:${childName}`, level, format, write, now })
  };

  // Adapters were written against a bare `log(message)` function; keep that
  // shape callable so a logger can be passed anywhere one was expected.
  return Object.assign((message, fields) => logger.info(message, fields), logger);
}
