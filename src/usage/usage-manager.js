import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

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
export function createUsageManager({ dataDir, now = () => new Date(), fetchImpl = globalThis.fetch } = {}) {
  if (!dataDir) throw new Error("Usage manager requires a dataDir");
  const files = {
    budgets: path.join(dataDir, "budgets.json"),
    models: path.join(dataDir, "models.json"),
    providers: path.join(dataDir, "providers.json"),
    promotions: path.join(dataDir, "promotions.json"),
    catalog: path.join(dataDir, "model-catalog.json"),
    ledger: path.join(dataDir, "usage-ledger.jsonl")
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

  async function record({ agent, model, sessionId, runId, usage, cost, source = "agent-reported" }) {
    if (!usage && !cost) return null;
    await ensure();
    const entry = {
      timestamp: now().toISOString(),
      agent,
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(usage ? { usage: normalizeUsage(usage) } : {}),
      ...(cost ? { cost } : {}),
      source
    };
    await appendFile(files.ledger, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
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
    return {
      profile: requested,
      candidates: blocked ? candidates.filter((candidate) => !candidate.startsWith("codex/")) : candidates,
      decision: blocked ? "degraded" : candidates.length ? "allowed" : "no-candidate",
      reason: blocked ? "Monthly budget is exhausted; premium subscription models were excluded." : "Matched the configured model profile.",
      maxEstimatedCost: limit,
      budget: current.budget
    };
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
    const [creditsResponse, modelsResponse] = await Promise.all([
      fetchImpl("https://openrouter.ai/api/v1/credits", { headers }),
      fetchImpl("https://openrouter.ai/api/v1/models", { headers })
    ]);
    if (!creditsResponse.ok) throw new Error(`OpenRouter credits request failed (${creditsResponse.status}). A management key may be required.`);
    if (!modelsResponse.ok) throw new Error(`OpenRouter model catalog request failed (${modelsResponse.status}).`);
    const [creditsPayload, modelsPayload] = await Promise.all([creditsResponse.json(), modelsResponse.json()]);
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

  return { ensure, record, status, report, recommend, check, syncOpenRouter, files };
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
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens ?? null,
    outputTokens: usage.outputTokens ?? usage.output_tokens ?? null,
    thoughtTokens: usage.thoughtTokens ?? usage.thought_tokens ?? null,
    cachedReadTokens: usage.cachedReadTokens ?? usage.cached_read_tokens ?? null,
    cachedWriteTokens: usage.cachedWriteTokens ?? usage.cached_write_tokens ?? null,
    totalTokens: usage.totalTokens ?? usage.total_tokens ?? null
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
