/**
 * Write-capable modes must be asked for by name.
 *
 * These constants are a deliberate speed bump, not an authorization boundary:
 * anything that can call the tool can also send the literal string. What they
 * buy is that no agent reaches a write-capable mode by defaulting into it or by
 * a model guessing a flag — the caller has to state the intent. The real
 * boundary is the sandbox each adapter asks its CLI for, plus whatever the host
 * requires before invoking the tool at all.
 */
export function authorizeMode(mode) {
  const effectiveMode = mode ?? "plan";
  if (!["plan", "default", "auto"].includes(effectiveMode)) throw new Error(`Unsupported agent mode "${effectiveMode}"`);
  return effectiveMode;
}

export function requiresWriteAuthorization(mode) {
  return ["default", "auto"].includes(mode);
}
