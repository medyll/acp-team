/**
 * Shared contract every agent adapter implements.
 *
 * Transports differ (Kimi speaks ACP over stdio, Codex is a one-shot CLI with a
 * JSONL event stream) but callers only ever see this shape.
 *
 * @typedef {Object} AskResult
 * @property {string} sessionId    Id to pass back to continue this conversation.
 * @property {string} text         Final assistant message.
 * @property {string} thoughts     Reasoning stream, empty when unavailable.
 * @property {Array<{title: string, status: string}>} toolCalls
 * @property {string} stopReason
 *
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} description
 * @property {string[]} modes          Permission modes the agent understands.
 * @property {() => Promise<object>} status
 * @property {(opts: object) => Promise<AskResult>} ask
 * @property {(sessionId: string) => void} cancel
 */

/** Modes shared by every adapter; each one maps them onto its own vocabulary. */
export const MODES = ["default", "plan", "auto"];

export function assertSupportedMode(mode) {
  if (mode && !MODES.includes(mode)) throw new Error(`Unsupported agent mode "${mode}". Available: ${MODES.join(", ")}`);
  return mode;
}

/** Normalize a tool call from any transport into the common summary shape. */
export function toolSummary(title, status) {
  return { title: title ?? "(untitled)", status: status ?? "unknown" };
}
