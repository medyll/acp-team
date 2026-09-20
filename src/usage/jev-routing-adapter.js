import { deadlineSignal, fetchWithRetry, readJsonResponse } from "../resilience.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const PROFILES = ["cheap", "standard", "premium"];

// Keep the provider payload limited to the caller-supplied task. Candidate lists,
// budgets, repository contents, and authorization state never cross this boundary.
const QUESTIONS = {
  profile: {
    type: "choice",
    instructions: "Which acp-team execution profile best matches the coding task in `task`?",
    criteria: {
      cheap: "A small mechanical change with narrow scope and low regression risk.",
      standard: "Ordinary implementation, debugging, testing, or explanation within a bounded subsystem.",
      premium: "Cross-cutting, architecture-sensitive, migration, audit, or otherwise high-risk work."
    }
  },
  requires_write: {
    type: "noul",
    instructions: "Does completing the task in `task` require modifying files or other persistent state?",
    criteria: {
      true: "The requested outcome requires a persistent change.",
      false: "The request is satisfied by reading, explaining, reviewing, or planning only."
    }
  },
  complexity: {
    type: "score",
    instructions: "How complex and risky is the coding task in `task`?",
    criteria: [
      "Mechanical and localized, with little interaction risk.",
      "Normal engineering work within a bounded subsystem.",
      "Cross-cutting or high-risk, with compatibility, architecture, or migration concerns."
    ]
  },
  needs_clarification: {
    type: "noul",
    instructions: "Is essential information missing from `task` such that materially different implementations are plausible?",
    criteria: {
      true: "A missing choice or requirement would materially change the result.",
      false: "A competent engineer can proceed safely using ordinary local assumptions."
    }
  }
};

export class JevRoutingError extends Error {
  constructor(category, message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "JevRoutingError";
    this.category = category;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Create a server-side Jev adviser. The adapter owns transport and response
 * validation; callers own policy and decide whether advice can affect routing.
 */
export function createJevRoutingAdapter({
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  timeoutMs = 10_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  retryOptions,
  clock = Date
} = {}) {
  // Routing replies are small. Retain this ceiling even when the host permits
  // larger responses for unrelated provider catalogs.
  const responseByteLimit = Math.min(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  return {
    async advise(task) {
      if (!apiKey) throw new JevRoutingError("missing-key", "Jev routing needs TYPESAFE_API_KEY.");
      if (typeof fetchImpl !== "function") throw new JevRoutingError("network", "No fetch implementation is available for Jev routing.");
      if (typeof task !== "string" || !task.trim()) throw new JevRoutingError("invalid-task", "Jev routing needs a non-empty task description.");

      const startedAt = clock.now();
      const deadline = deadlineSignal(undefined, timeoutMs, "Jev routing");
      try {
        const response = await fetchWithRetry(fetchImpl, endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model, state: { task }, questions: QUESTIONS }),
          signal: deadline.signal,
          redirect: "error"
        }, retryOptions);

        const payload = await readJsonResponse(response, { maxBytes: responseByteLimit, label: "Jev response" });
        if (!response.ok) throw responseError(response.status, payload);
        // Typed output is still network input. Reject any missing or out-of-range
        // field so the usage manager takes its deterministic fallback path.
        const parsed = validateResponse(payload);
        return {
          profile: parsed.profile.choice,
          profileConfidence: parsed.profile.confidence,
          requiresWrite: parsed.requiresWrite.noul,
          complexity: parsed.complexity.score,
          needsClarification: parsed.needsClarification.noul,
          provider: "jev",
          model: parsed.model,
          distributions: {
            profile: parsed.profile.probabilities,
            complexity: parsed.complexity.probabilities
          },
          confidence: {
            profile: parsed.profile.confidence,
            complexity: parsed.complexity.confidence
          },
          latencyMs: Math.max(0, clock.now() - startedAt),
          usage: {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens
          }
        };
      } catch (error) {
        if (error instanceof JevRoutingError) throw error;
        if (deadline.signal.aborted) {
          throw new JevRoutingError("timeout", `Jev routing timed out after ${timeoutMs}ms.`, { cause: error });
        }
        throw new JevRoutingError("network", "Jev routing could not reach TypeSafe.", { cause: error });
      } finally {
        deadline.cleanup();
      }
    }
  };
}

/**
 * Resolve routing at the composition root. Active Jev routing fails closed until
 * the shadow corpus passes its separate activation review.
 */
export function routingOptionsFromEnvironment({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxResponseBytes,
  retryOptions
} = {}) {
  const routingProvider = env.ACP_TEAM_ROUTING_PROVIDER || "heuristic";
  if (!["heuristic", "jev-shadow", "jev"].includes(routingProvider)) {
    throw new Error(`ACP_TEAM_ROUTING_PROVIDER must be "heuristic", "jev-shadow", or "jev" (received "${routingProvider}")`);
  }
  if (routingProvider === "jev") {
    throw new Error("ACP_TEAM_ROUTING_PROVIDER=jev is intentionally unavailable until the shadow evaluation passes.");
  }
  if (routingProvider === "heuristic") return { routingProvider };
  return {
    routingProvider,
    routingAdvisor: createJevRoutingAdapter({
      apiKey: env.TYPESAFE_API_KEY,
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
      retryOptions
    })
  };
}

export function routingErrorCategory(error) {
  return error instanceof JevRoutingError ? error.category : "unknown";
}

function responseError(status, payload) {
  const category = status === 401 ? "authentication"
    : status === 429 ? "rate-limit"
      : status >= 500 ? "provider-unavailable"
        : "request-rejected";
  const detail = typeof payload?.message === "string" ? `: ${payload.message}` : "";
  return new JevRoutingError(category, `Jev request failed (${status})${detail}`, { status });
}

function validateResponse(payload) {
  if (!isObject(payload) || typeof payload.model !== "string" || !isObject(payload.answers) || !isObject(payload.usage)) {
    throw malformed();
  }
  const profile = payload.answers.profile;
  const requiresWrite = payload.answers.requires_write;
  const complexity = payload.answers.complexity;
  const needsClarification = payload.answers.needs_clarification;
  if (!isChoice(profile, PROFILES) || !isNoul(requiresWrite) || !isScore(complexity, 3) || !isNoul(needsClarification)) {
    throw malformed();
  }
  if (!isNonNegativeInteger(payload.usage.input_tokens) || !isNonNegativeInteger(payload.usage.output_tokens)) {
    throw malformed();
  }
  return { model: payload.model, profile, requiresWrite, complexity, needsClarification, usage: payload.usage };
}

function isChoice(value, labels) {
  return isObject(value)
    && value.type === "choice"
    && labels.includes(value.choice)
    && isProbability(value.confidence)
    && isDistribution(value.probabilities, labels);
}

function isNoul(value) {
  return isObject(value) && value.type === "noul" && isProbability(value.noul);
}

function isScore(value, levels) {
  const labels = Array.from({ length: levels }, (_, index) => String(index));
  return isObject(value)
    && value.type === "score"
    && Number.isFinite(value.score)
    && value.score >= 0
    && value.score <= levels - 1
    && isProbability(value.confidence)
    && isDistribution(value.probabilities, labels);
}

function isDistribution(value, labels) {
  return isObject(value) && labels.every((label) => isProbability(value[label]));
}

function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed() {
  return new JevRoutingError("malformed-response", "Jev returned a malformed routing response.");
}
