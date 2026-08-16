/**
 * What a mode is allowed to be, and which modes need more than a request.
 *
 * This module answers only the first half: an absent mode is read-only, and an
 * unknown one is refused rather than passed to an adapter that might interpret
 * it loosely. It deliberately grants nothing — `requiresWriteAuthorization`
 * marks the modes that must additionally present a scoped, expiring token to
 * the authorization manager, which is where the actual boundary lives. Beneath
 * both sits the sandbox each adapter requests from its own CLI.
 */
export function authorizeMode(mode) {
  const effectiveMode = mode ?? "plan";
  if (!["plan", "default", "auto"].includes(effectiveMode)) throw new Error(`Unsupported agent mode "${effectiveMode}"`);
  return effectiveMode;
}

export function requiresWriteAuthorization(mode) {
  return ["default", "auto"].includes(mode);
}
