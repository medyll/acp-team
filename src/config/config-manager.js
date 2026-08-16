import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSettings, SETTINGS_DEFAULTS, validateRuntimeSettings } from "./runtime-config.js";

/** Proposals and rollback snapshots accumulate forever otherwise. */
const DEFAULT_RETAINED_PROPOSALS = 50;
const DEFAULT_RETAINED_BACKUPS = 30;

const MANAGED_FILES = {
  settings: "settings.json",
  budgets: "budgets.json",
  models: "models.json",
  providers: "providers.json",
  promotions: "promotions.json",
  catalog: "model-catalog.json"
};

export function createConfigManager({
  dataDir,
  now = () => new Date(),
  retainedProposals = DEFAULT_RETAINED_PROPOSALS,
  retainedBackups = DEFAULT_RETAINED_BACKUPS
} = {}) {
  if (!dataDir) throw new Error("Config manager requires a dataDir");
  const proposalsDir = path.join(dataDir, "proposals");
  const historyDir = path.join(dataDir, "history");

  async function ensure() {
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(proposalsDir, { recursive: true }), mkdir(historyDir, { recursive: true })]);
    await ensureJson(path.join(dataDir, MANAGED_FILES.settings), SETTINGS_DEFAULTS);
  }

  async function inspect() {
    await ensure();
    const files = {};
    for (const [name, filename] of Object.entries(MANAGED_FILES)) {
      const document = await readJson(path.join(dataDir, filename), name === "settings" ? SETTINGS_DEFAULTS : {});
      files[name] = name === "settings" ? normalizeSettings(document) : document;
    }
    return { dataDir, files };
  }

  async function get(key) {
    const snapshot = await inspect();
    return getPath(snapshot.files, normalizeConfigKey(key));
  }

  async function set(key, value) {
    const [file, ...segments] = splitPropertyPath(normalizeConfigKey(key));
    assertManagedFile(file);
    if (!segments.length) throw new Error("A configuration key must include a property path");
    assertNonSecretPath(segments.join("."), file);
    const target = path.join(dataDir, MANAGED_FILES[file]);
    const raw = await readJson(target, file === "settings" ? SETTINGS_DEFAULTS : {});
    const document = file === "settings" ? normalizeSettings(raw) : raw;
    setPath(document, segments, value);
    if (file === "settings") validateRuntimeSettings(document);
    await writeJsonAtomic(target, document);
    return { key, value };
  }

  async function stage(proposal) {
    await ensure();
    validateProposal(proposal);
    const id = proposal.id || `cfg_${stamp(now())}`;
    const document = { ...proposal, id, schemaVersion: 1, createdAt: now().toISOString(), status: "proposed" };
    const file = path.join(proposalsDir, `${id}.json`);
    await writeJsonAtomic(file, document);
    await prune(proposalsDir, retainedProposals);
    return { ...document, file };
  }

  /**
   * Ids embed a sortable timestamp, so keeping the lexicographic tail keeps the
   * most recent entries. Pruning never fails a caller: losing an old snapshot is
   * not worth failing a configuration change over.
   */
  async function prune(directory, keep) {
    if (!Number.isFinite(keep) || keep <= 0) return [];
    try {
      const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      const stale = names.slice(0, Math.max(0, names.length - keep));
      for (const name of stale) await unlink(path.join(directory, name)).catch(() => {});
      return stale;
    } catch {
      return [];
    }
  }

  async function loadProposal(id) {
    await ensure();
    const safeId = safeProposalId(id);
    return readJson(path.join(proposalsDir, `${safeId}.json`));
  }

  async function apply(id) {
    const proposal = await loadProposal(id);
    validateProposal(proposal);
    if (proposal.status === "applied") throw new Error(`Proposal ${proposal.id} is already applied`);
    const snapshot = await inspect();
    const changed = new Map();
    for (const change of proposal.changes) {
      assertManagedFile(change.file);
      const document = changed.get(change.file) ?? structuredClone(snapshot.files[change.file]);
      setPath(document, splitPropertyPath(change.path), change.value);
      changed.set(change.file, document);
    }
    if (changed.has("settings")) validateRuntimeSettings(normalizeSettings(changed.get("settings")));
    const backupId = `history_${stamp(now())}_${proposal.id}`;
    await writeJsonAtomic(path.join(historyDir, `${backupId}.json`), {
      id: backupId,
      createdAt: now().toISOString(),
      proposalId: proposal.id,
      files: snapshot.files
    });
    for (const [file, document] of changed) {
      await writeJsonAtomic(path.join(dataDir, MANAGED_FILES[file]), document);
    }
    proposal.status = "applied";
    proposal.appliedAt = now().toISOString();
    proposal.backupId = backupId;
    await writeJsonAtomic(path.join(proposalsDir, `${proposal.id}.json`), proposal);
    await prune(historyDir, retainedBackups);
    return { proposalId: proposal.id, backupId, files: [...changed.keys()] };
  }

  async function rollback(backupId) {
    const safeId = safeProposalId(backupId);
    const backup = await readJson(path.join(historyDir, `${safeId}.json`));
    for (const [file, document] of Object.entries(backup.files ?? {})) {
      assertManagedFile(file);
      await writeJsonAtomic(path.join(dataDir, MANAGED_FILES[file]), document);
    }
    return { backupId, files: Object.keys(backup.files ?? {}) };
  }

  async function runtime() {
    await ensure();
    return normalizeSettings(await readJson(path.join(dataDir, MANAGED_FILES.settings), SETTINGS_DEFAULTS));
  }

  async function migrate() {
    const settings = await runtime();
    validateRuntimeSettings(settings);
    await writeJsonAtomic(path.join(dataDir, MANAGED_FILES.settings), settings);
    return { schemaVersion: settings.schemaVersion, file: path.join(dataDir, MANAGED_FILES.settings) };
  }

  return { ensure, inspect, get, set, stage, loadProposal, apply, rollback, prune, runtime, migrate, dataDir, proposalsDir, historyDir };
}

export function validateProposal(proposal) {
  if (!proposal || !Array.isArray(proposal.changes)) throw new Error("Proposal must contain a changes array");
  if (proposal.changes.length > 100) throw new Error("A proposal cannot contain more than 100 changes");
  for (const change of proposal.changes) {
    assertManagedFile(change.file);
    if (!change.path || typeof change.path !== "string") throw new Error("Every change needs a property path");
    if (change.path.length > 256) throw new Error("Configuration property paths cannot exceed 256 characters");
    splitPropertyPath(change.path);
    assertNonSecretPath(change.path, change.file);
    let serialized;
    try { serialized = JSON.stringify(change.value); } catch { throw new Error(`Configuration value must be JSON-serializable: ${change.file}.${change.path}`); }
    if (serialized === undefined || Buffer.byteLength(serialized) > 256 * 1024) {
      throw new Error(`Configuration value is too large: ${change.file}.${change.path}`);
    }
  }
  return proposal;
}

function assertNonSecretPath(propertyPath, file) {
  if (/(?:key|secret|token|password|credential|authorization|bearer)/i.test(propertyPath)) {
    throw new Error(`Secrets cannot be written through configuration: ${file}.${propertyPath}`);
  }
}

function splitKey(key) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Configuration key is required");
  return key.split(".").filter(Boolean);
}

function normalizeConfigKey(key) {
  const segments = splitKey(key);
  return Object.hasOwn(MANAGED_FILES, segments[0]) ? segments.join(".") : `settings.${segments.join(".")}`;
}

function splitPropertyPath(value) {
  const segments = splitKey(value);
  if (segments.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error("Unsafe configuration property path");
  }
  return segments;
}

function assertManagedFile(file) {
  // Own-property only: a plain `MANAGED_FILES[file]` lookup answers truthily for
  // "__proto__", "constructor" and every other inherited key, which let a
  // section name off the prototype chain through this guard and fail later as a
  // confusing path.join type error.
  if (!Object.hasOwn(MANAGED_FILES, file)) {
    throw new Error(`Unknown configuration section "${file}". Available: ${Object.keys(MANAGED_FILES).join(", ")}`);
  }
}

function getPath(root, key) {
  // splitPropertyPath, not splitKey: reading `__proto__.x` would walk the
  // prototype chain and report an inherited value as configuration.
  return splitPropertyPath(key).reduce((value, segment) => (Object.hasOwn(Object(value), segment) ? value[segment] : undefined), root);
}

function setPath(root, segments, value) {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== "object" || Array.isArray(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[segments.at(-1)] = value;
}

function safeProposalId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid proposal id");
  return id;
}

function stamp(date) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function ensureJson(file, fallback) {
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeJsonAtomic(file, fallback);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
