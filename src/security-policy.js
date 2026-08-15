/**
 * Write-capable and unsandboxed modes must be asked for by name.
 *
 * These constants are a deliberate speed bump, not an authorization boundary:
 * anything that can call the tool can also send the literal string. What they
 * buy is that no agent reaches a write-capable mode by defaulting into it or by
 * a model guessing a flag — the caller has to state the intent. The real
 * boundary is the sandbox each adapter asks its CLI for, plus whatever the host
 * requires before invoking the tool at all.
 */
export const YOLO_CONFIRMATION = "ALLOW_UNSANDBOXED_AGENT";
export const WRITE_CONFIRMATION = "ALLOW_AGENT_WRITE";

export function authorizeMode(mode, { confirmWrite, confirmYolo } = {}) {
  const effectiveMode = mode ?? "plan";
  if (effectiveMode === "yolo" && confirmYolo !== YOLO_CONFIRMATION) {
    throw new Error(`Mode yolo requires confirm_yolo="${YOLO_CONFIRMATION}"`);
  }
  if (["default", "auto"].includes(effectiveMode) && confirmWrite !== WRITE_CONFIRMATION) {
    throw new Error(`Mode ${effectiveMode} requires confirm_write="${WRITE_CONFIRMATION}"`);
  }
  return effectiveMode;
}
