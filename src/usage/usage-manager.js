import { mkdir, readFile, writeFile, appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { deadlineSignal, fetchWithRetry, readJsonResponse } from "../resilience.js";

const DEFAULT_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Reports only ever span a day, a week or a month, so anything older than this
 * can leave the hot ledger without changing a single reported number.
 */
const DEFAULT_LEDGER_RETENTION_DAYS = 120;

const DEFAULT_BUDGETS = {
  currency: "USD",
  periods: { daily: null, weekly: null, monthly: null },
  thresholds: { warnAtPercent: 80, blockAtPercent: 100 },
  profiles: {
    cheap: { maxEstimatedCost: 0.1 },
    standard: { maxEstimatedCost: 0.5 },
    premium: { maxEstimatedCost: null }
  }
};

const DEFAULT_MODELS = {
  profiles: {
    cheap: ["opencode/default"],
    standard: ["codex/default", "opencode/default"],
    premium: ["codex/default", "kimi/default"]
  },
  disabled: []
};

const DEFAULT_PROVIDERS = {
  codex: { billingMode: "subscription", quotaSource: "unknown" },
  kimi: { billingMode: "subscription", quotaSource: "unknown" },
  opencode: { billingMode: "mixed", quotaSource: "agent-reported" },
  ollama: { billingMode: "local", quotaSource: "local-runtime" }
};

const DEFAULT_PROMOTIONS = { promotions: [] };

/**
 * Persistent, provider-neutral usage ledger. It never guesses an account
 * balance: observed tokens, reported cost and configured budgets remain
 * distinct so a host can explain where every number came from.
 */
export function createUsageManager({
  dataDir,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxResponseBytes,
  retryOptions,
  ledgerMaxBytes = DEFAULT_LEDGER_MAX_BYTES,
  ledgerRetentionDays = DEFAULT_LEDGER_RETENTION_DAYS
} = {}) {
  if (!dataDir) throw new Error("Usage manager requires a dataDir");
  const files = {
    budgets: path.join(dataDir, "budgets.json"),
    models: path.join(dataDir, "models.json"),
    providers: path.join(dataDir, "providers.json"),
    promotions: path.join(dataDir, "promotions.json"),
    catalog: path.join(dataDir, "model-catalog.json"),
    ledger: path.join(dataDir, "usage-ledger.jsonl"),
    archive: path.join(dataDir, "usage-ledger.archive.jsonl"),
    rollups: path.join(dataDir, "usage-rollups.json"),
    ratings: path.join(dataDir, "model-ratings.jsonl")
  };

  async function ensure() {
    await mkdir(dataDir, { recursive: true });
    await Promise.all([
      ensureJson(files.budgets, DEFAULT_BUDGETS),
      ensureJson(files.models, DEFAULT_MODELS),
      ensureJson(files.providers, DEFAULT_PROVIDERS),
      ensureJson(files.promotions, DEFAULT_PROMOTIONS)
    ]);
  }

  async function record({ agent, model, sessionId, runId, usage, cost, outcome, latencyMs, source = "agent-reported" }) {
    if (!usage && !cost && !outcome) return null;
    await ensure();
    const entry = {
      timestamp: now().toISOString(),
      agent,
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(usage ? { usage: normalizeUsage(usage) } : {}),
      ...(cost ? { cost } : {}),
      ...(outcome ? { outcome } : {}),
      ...(Number.isFinite(latencyMs) ? { latencyMs } : {}),
      source
    };
    await appendFile(files.ledger, `${JSON.stringify(entry)}\n`, "utf8");
    await compactIfNeeded();
    return entry;
  }

  /**
   * Every status/report call parses the whole ledger, so an unbounded file makes
   * every reply slower forever. Once it crosses the size limit, entries older
   * than the retention window move to an append-only archive and are folded into
   * per-month rollups, keeping the historical totals available without keeping
   * every line hot.
   */
  async function compactIfNeeded({ force = false } = {}) {
    if (!force) {
      try {
        const info = await stat(files.ledger);
        if (info.size < ledgerMaxBytes) return null;
      } catch {
        return null;
      }
    }

    const entries = await readLedger(files.ledger);
    const cutoff = new Date(now().getTime() - ledgerRetentionDays * 86_400_000);
    const retained = [];
    const expired = [];
    for (const entry of entries) {
      (new Date(entry.timestamp) < cutoff ? expired : retained).push(entry);
    }
    if (!expired.length) return { compacted: false, reason: "nothing older than the retention window", retained: retained.length };

    const rollups = await readJson(files.rollups, { months: {} });
    for (const entry of expired) {
      const month = String(entry.timestamp).slice(0, 7);
      const key = `${entry.agent}:${entry.model ?? "default"}`;
      rollups.months[month] ??= {};
      rollups.months[month][key] = addUsage(rollups.months[month][key] ?? emptyTotals(), entry);
    }
    rollups.compactedAt = now().toISOString();

    await appendFile(files.archive, expired.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    await writeJson(files.rollups, rollups);
    await writeLedgerAtomic(files.ledger, retained);
    return { compacted: true, archived: expired.length, retained: retained.length };
  }

  async function status({ period = "month", agent, model } = {}) {
    await ensure();
    const [budgets, providers, promotions, entries] = await Promise.all([
      readJson(files.budgets, DEFAULT_BUDGETS),
      readJson(files.providers, DEFAULT_PROVIDERS),
      readJson(files.promotions, DEFAULT_PROMOTIONS),
      readLedger(files.ledger)
    ]);
    const start = periodStart(period, now());
    const selected = entries.filter(
      (entry) => new Date(entry.timestamp) >= start && (!agent || entry.agent === agent) && (!model || entry.model === model)
    );
    const totals = selected.reduce(addUsage, emptyTotals());
    const promotion = activePromotion(promotions.promotions, now());
    const configuredBudget = budgets.periods?.[`${period}ly`] ?? null;
    const multiplier = Number.isFinite(promotion?.budgetMultiplier ?? promotion?.multiplier) ? (promotion.budgetMultiplier ?? promotion.multiplier) : 1;
    const budget = typeof configuredBudget === "number" ? configuredBudget * multiplier : null;
    const remaining = typeof budget === "number" && typeof totals.cost.amount === "number" ? budget - totals.cost.amount : null;
    return {
      period: { kind: period, startsAt: start.toISOString(), endsAt: nextPeriodStart(period, now()).toISOString() },
      filters: { ...(agent ? { agent } : {}), ...(model ? { model } : {}) },
      totals,
      budget: {
        amount: budget,
        configuredAmount: configuredBudget,
        multiplier,
        currency: budgets.currency ?? "USD",
        remaining,
        status: budget === null ? "not-configured" : remaining !== null && remaining <= 0 ? "blocked" : "within-budget"
      },
      providers,
      promotion: promotion ?? null,
      dataDir
    };
  }

  async function report({ period = "month", agent, model } = {}) {
    const overview = await status({ period, agent, model });
    const entries = await readLedger(files.ledger);
    const start = new Date(overview.period.startsAt);
    const groups = new Map();
    for (const entry of entries) {
      if (new Date(entry.timestamp) < start || (agent && entry.agent !== agent) || (model && entry.model !== model)) continue;
      const key = `${entry.agent}:${entry.model ?? "default"}`;
      groups.set(key, addUsage(groups.get(key) ?? emptyTotals(), entry));
    }
    return { ...overview, byModel: [...groups.entries()].map(([key, totals]) => ({ key, totals })) };
  }

  async function recommend({ task, profile = "standard" } = {}) {
    await ensure();
    const [models, budgets, current] = await Promise.all([
      readJson(files.models, DEFAULT_MODELS),
      readJson(files.budgets, DEFAULT_BUDGETS),
      status({ period: "month" })
    ]);
    const requested = profile === "auto" ? inferProfile(task) : profile;
    const candidates = (models.profiles?.[requested] ?? []).filter((candidate) => !models.disabled?.includes(candidate));
    const limit = budgets.profiles?.[requested]?.maxEstimatedCost ?? null;
    const blocked = current.budget.status === "blocked" && requested === "premium";
    const allowedCandidates = blocked ? candidates.filter((candidate) => !candidate.startsWith("codex/")) : candidates;
    const observed = await ratingSummary({ candidates: allowedCandidates });
    const ranked = [...allowedCandidates].sort((left, right) => (observed[right]?.score ?? 50) - (observed[left]?.score ?? 50));
    return {
      profile: requested,
      candidates: ranked,
      ratings: ranked.map((candidate) => ({ candidate, ...(observed[candidate] ?? { score: 50, confidence: "none" }) })),
      decision: blocked ? "degraded" : candidates.length ? "allowed" : "no-candidate",
      reason: blocked ? "Monthly budget is exhausted; premium subscription models were excluded." : "Matched the configured model profile.",
      maxEstimatedCost: limit,
      budget: current.budget
    };
  }

  async function rate({ runId, agent, model, rating, note } = {}) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Rating must be an integer from 1 to 5");
    await ensure();
    if (runId && (!agent || !model)) {
      const match = (await readLedger(files.ledger)).findLast((entry) => entry.runId === runId);
      agent ??= match?.agent;
      model ??= match?.model ?? "default";
    }
    if (!agent) throw new Error("Rating requires an agent or a known runId");
    const entry = { timestamp: now().toISOString(), runId: runId ?? null, agent, model: model ?? "default", rating, ...(note ? { note: String(note).slice(0, 500) } : {}) };
    await appendFile(files.ratings, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async function ratings({ agent, model } = {}) {
    const entries = await readLedger(files.ratings);
    const selected = entries.filter((entry) => (!agent || entry.agent === agent) && (!model || entry.model === model));
    return { entries: selected, summary: await ratingSummary({}) };
  }

  async function ratingSummary({ candidates } = {}) {
    const [ledger, manual] = await Promise.all([readLedger(files.ledger), readLedger(files.ratings)]);
    const keys = new Set(candidates ?? []);
    for (const entry of [...ledger, ...manual]) keys.add(`${entry.agent}/${entry.model ?? "default"}`);
    const summary = {};
    for (const key of keys) {
      const [agent, ...modelParts] = key.split("/");
      const model = modelParts.join("/") || "default";
      const outcomes = ledger.filter((entry) => entry.agent === agent && (entry.model ?? "default") === model && entry.outcome);
      const notes = manual.filter((entry) => entry.agent === agent && (entry.model ?? "default") === model);
      const completed = outcomes.filter((entry) => entry.outcome === "completed");
      const decided = outcomes.filter((entry) => ["completed", "failed"].includes(entry.outcome));
      const averageRating = average(notes.map((entry) => entry.rating));
      const successRate = decided.length ? completed.length / decided.length : null;
      const averageLatencyMs = average(completed.map((entry) => entry.latencyMs).filter(Number.isFinite));
      const averageCost = average(completed.map((entry) => entry.cost?.amount).filter(Number.isFinite));
      const score = Math.round((averageRating === null ? 60 : averageRating * 20) * 0.6 + (successRate === null ? 70 : successRate * 100) * 0.4);
      summary[key] = { score, averageRating, ratings: notes.length, successRate, runs: decided.length, averageLatencyMs, averageCost, confidence: notes.length + decided.length >= 5 ? "high" : notes.length + decided.length ? "low" : "none" };
    }
    return summary;
  }

  async function check({ profile = "standard", estimatedCost, currency = "USD" } = {}) {
    const current = await status({ period: "month" });
    const configured = await readJson(files.budgets, DEFAULT_BUDGETS);
    const profileLimit = configured.profiles?.[profile]?.maxEstimatedCost ?? null;
    const exceedsTaskLimit = typeof profileLimit === "number" && typeof estimatedCost === "number" && estimatedCost > profileLimit;
    const exceedsBudget = typeof current.budget.remaining === "number" && typeof estimatedCost === "number" && estimatedCost > current.budget.remaining;
    return {
      allowed: !exceedsTaskLimit && !exceedsBudget,
      reason: exceedsBudget ? "Estimated cost exceeds the remaining monthly budget." : exceedsTaskLimit ? "Estimated cost exceeds this profile's per-run limit." : "Within configured limits.",
      estimatedCost: estimatedCost ?? null,
      currency,
      profile,
      budget: current.budget
    };
  }

  async function syncOpenRouter({ apiKey } = {}) {
    if (!apiKey) throw new Error("OpenRouter sync needs OPENROUTER_MANAGEMENT_KEY (or OPENROUTER_API_KEY).");
    if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for provider sync.");
    await ensure();
    const headers = { Authorization: `Bearer ${apiKey}` };
    const deadline = deadlineSignal(undefined, timeoutMs, "OpenRouter sync");
    const options = { headers, signal: deadline.signal, redirect: "error" };
    let creditsResponse;
    let modelsResponse;
    let creditsPayload;
    let modelsPayload;
    try {
      [creditsResponse, modelsResponse] = await Promise.all([
        fetchWithRetry(fetchImpl, "https://openrouter.ai/api/v1/credits", options, retryOptions),
        fetchWithRetry(fetchImpl, "https://openrouter.ai/api/v1/models", options, retryOptions)
      ]);
      if (!creditsResponse.ok) throw new Error(`OpenRouter credits request failed (${creditsResponse.status}). A management key may be required.`);
      if (!modelsResponse.ok) throw new Error(`OpenRouter model catalog request failed (${modelsResponse.status}).`);
      [creditsPayload, modelsPayload] = await Promise.all([
        readJsonResponse(creditsResponse, { maxBytes: maxResponseBytes, label: "OpenRouter credits response" }),
        readJsonResponse(modelsResponse, { maxBytes: maxResponseBytes, label: "OpenRouter catalog response" })
      ]);
    } finally {
      deadline.cleanup();
    }
    const credits = creditsPayload.data ?? creditsPayload;
    const models = (modelsPayload.data ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length,
      pricing: model.pricing,
      supportedParameters: model.supported_parameters,
      expiresAt: model.expiration_date ?? null
    }));
    const providers = await readJson(files.providers, DEFAULT_PROVIDERS);
    providers.openrouter = {
      billingMode: "prepaid",
      quotaSource: "api",
      credits: {
        total: credits.total_credits ?? null,
        used: credits.total_usage ?? null,
        remaining: numericDifference(credits.total_credits, credits.total_usage),
        currency: "USD"
      },
      syncedAt: now().toISOString()
    };
    await Promise.all([
      writeJson(files.providers, providers),
      writeJson(files.catalog, { provider: "openrouter", syncedAt: now().toISOString(), models })
    ]);
    return { provider: "openrouter", credits: providers.openrouter.credits, modelCount: models.length, syncedAt: providers.openrouter.syncedAt };
  }

  return { ensure, record, status, report, recommend, rate, ratings, check, syncOpenRouter, compactIfNeeded, files };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function writeLedgerAtomic(file, entries) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  await rename(temporary, file);
}

async function ensureJson(file, fallback) {
  try { await readFile(file, "utf8"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(file, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  }
}
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readLedger(file) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function normalizeUsage(usage) {
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? null;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? null;
  const reported = usage.totalTokens ?? usage.total_tokens ?? null;
  return {
    inputTokens,
    outputTokens,
    thoughtTokens: usage.thoughtTokens ?? usage.thought_tokens ?? null,
    cachedReadTokens: usage.cachedReadTokens ?? usage.cached_read_tokens ?? null,
    cachedWriteTokens: usage.cachedWriteTokens ?? usage.cached_write_tokens ?? null,
    // Most agents report the parts and leave the sum out; reporting a zero total
    // next to a six-figure input reads as "no usage", which is worse than a
    // derived figure. A total the agent does report always wins.
    totalTokens: reported ?? (inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0))
  };
}
function emptyTotals() { return { runs: 0, tokens: { input: 0, output: 0, thought: 0, cachedRead: 0, cachedWrite: 0, total: 0 }, cost: { amount: null, currency: null, source: "unavailable" } }; }
function addUsage(total, entry) {
  const usage = normalizeUsage(entry.usage ?? {});
  const next = structuredClone(total);
  next.runs += 1;
  next.tokens.input += usage.inputTokens ?? 0; next.tokens.output += usage.outputTokens ?? 0; next.tokens.thought += usage.thoughtTokens ?? 0;
  next.tokens.cachedRead += usage.cachedReadTokens ?? 0; next.tokens.cachedWrite += usage.cachedWriteTokens ?? 0; next.tokens.total += usage.totalTokens ?? 0;
  if (entry.cost?.amount !== undefined && entry.cost?.amount !== null) {
    next.cost.amount = (next.cost.amount ?? 0) + entry.cost.amount;
    next.cost.currency = entry.cost.currency ?? next.cost.currency;
    next.cost.source = entry.source;
  }
  return next;
}
function periodStart(period, date) { const result = new Date(date); result.setHours(0, 0, 0, 0); if (period === "week") result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); if (period === "month") result.setDate(1); return result; }
function nextPeriodStart(period, date) { const result = periodStart(period, date); if (period === "day") result.setDate(result.getDate() + 1); else if (period === "week") result.setDate(result.getDate() + 7); else result.setMonth(result.getMonth() + 1); return result; }
function activePromotion(promotions = [], date) { return promotions.find((promotion) => !promotion.startsAt || (new Date(promotion.startsAt) <= date && (!promotion.expiresAt || new Date(promotion.expiresAt) > date))); }
function inferProfile(task = "") { return /refactor|architecture|audit|migration|complex|large/i.test(task) ? "premium" : /typo|format|rename|simple|short/i.test(task) ? "cheap" : "standard"; }
function numericDifference(total, used) { return Number.isFinite(total) && Number.isFinite(used) ? total - used : null; }
