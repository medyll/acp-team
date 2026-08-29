import path from "node:path";
import { authorizeMode, requiresWriteAuthorization } from "../security-policy.js";

/**
 * Parse the host adapters whose injected caller context this bridge trusts.
 * Trust is opt-in because ordinary tool arguments are controlled by the model.
 */
export function trustedCallerHosts(value = process.env.ACP_TEAM_TRUSTED_CALLER_HOSTS) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Resolve a callee's effective mode. An explicit callee mode wins; otherwise a
 * trusted host context is inherited. Without trusted context, the historical
 * read-only default remains in force.
 */
export function resolveDelegationAccess({ requestedMode, callerContext, cwd, trustedHosts = new Set() }) {
  const caller = trustedCallerContext(callerContext, trustedHosts);
  const mode = authorizeMode(requestedMode ?? caller?.mode);
  const coveredByCaller = Boolean(caller && coversMode(caller.mode, mode) && coversDirectory(caller.cwd, cwd));

  return {
    mode,
    caller,
    inherited: requestedMode === undefined && coveredByCaller,
    requiresAuthorization: requiresWriteAuthorization(mode) && !coveredByCaller,
    permissionSource: coveredByCaller ? "caller" : requiresWriteAuthorization(mode) ? "token" : "read-only"
  };
}

function trustedCallerContext(context, trustedHosts) {
  if (!context) return null;
  const host = context.host.toLowerCase();
  if (!trustedHosts.has(host)) return null;
  return {
    host,
    mode: authorizeMode(context.mode),
    sessionId: context.session_id,
    cwd: path.resolve(context.cwd)
  };
}

function coversMode(callerMode, calleeMode) {
  return modeLevel(callerMode) >= modeLevel(calleeMode);
}

function modeLevel(mode) {
  return requiresWriteAuthorization(mode) ? 1 : 0;
}

function coversDirectory(scope, target) {
  const relative = path.relative(path.resolve(scope), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
