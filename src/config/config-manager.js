import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SETTINGS_DEFAULTS = {
  schemaVersion: 1,
  controller: { default: "claude", model: null },
  interaction: { language: "fr", confirmWrites: true },
  discovery: { requireOfficialSources: true, maxAgeDays: 30 }
};

const MANAGED_FILES = {
  settings: "settings.json",
  budgets: "budgets.json",
  models: "models.json",
  providers: "providers.json",
  promotions: "promotions.json",
  catalog: "model-catalog.json"
};

export function createConfigManager({ dataDir, now = () => new Date() } = {}) {
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
      files[name] = await readJson(path.join(dataDir, filename), name === "settings" ? SETTINGS_DEFAULTS : {});
    }
    return { dataDir, files };
  }

  async function get(key) {
    const snapshot = await inspect();
    return getPath(snapshot.files, normalizeConfigKey(key));
  }

  async function set(key, value) {
    const [file, ...segments] = splitKey(normalizeConfigKey(key));
    assertManagedFile(file);
    if (!segments.length) throw new Error("A configuration key must include a property path");
    const target = path.join(dataDir, MANAGED_FILES[file]);
    const document = await readJson(target, file === "settings" ? SETTINGS_DEFAULTS : {});
    setPath(document, segments, value);
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
    return { ...document, file };
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
    const backupId = `history_${stamp(now())}_${proposal.id}`;
    await writeJsonAtomic(path.join(historyDir, `${backupId}.json`), {
      id: backupId,
      createdAt: now().toISOString(),
      proposalId: proposal.id,
      files: snapshot.files
    });

    const changed = new Map();
    for (const change of proposal.changes) {
      assertManagedFile(change.file);
      const document = changed.get(change.file) ?? structuredClone(snapshot.files[change.file]);
      setPath(document, splitPropertyPath(change.path), change.value);
      changed.set(change.file, document);
    }
    for (const [file, document] of changed) {
      await writeJsonAtomic(path.join(dataDir, MANAGED_FILES[file]), document);
    }
    proposal.status = "applied";
    proposal.appliedAt = now().toISOString();
    proposal.backupId = backupId;
    await writeJsonAtomic(path.join(proposalsDir, `${proposal.id}.json`), proposal);
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

  return { ensure, inspect, get, set, stage, loadProposal, apply, rollback, dataDir };
}

export function validateProposal(proposal) {
  if (!proposal || !Array.isArray(proposal.changes)) throw new Error("Proposal must contain a changes array");
  for (const change of proposal.changes) {
    assertManagedFile(change.file);
    if (!change.path || typeof change.path !== "string") throw new Error("Every change needs a property path");
    splitPropertyPath(change.path);
    if (change.path.toLowerCase().includes("key") || change.path.toLowerCase().includes("secret") || change.path.toLowerCase().includes("token")) {
      throw new Error(`Secrets cannot be written through configuration proposals: ${change.file}.${change.path}`);
    }
  }
  return proposal;
}

function splitKey(key) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Configuration key is required");
  return key.split(".").filter(Boolean);
}

function normalizeConfigKey(key) {
  const segments = splitKey(key);
  return MANAGED_FILES[segments[0]] ? segments.join(".") : `settings.${segments.join(".")}`;
}

function splitPropertyPath(value) {
  const segments = splitKey(value);
  if (segments.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error("Unsafe configuration property path");
  }
  return segments;
}

function assertManagedFile(file) {
  if (!MANAGED_FILES[file]) throw new Error(`Unknown configuration section "${file}". Available: ${Object.keys(MANAGED_FILES).join(", ")}`);
}

function getPath(root, key) {
  return splitKey(key).reduce((value, segment) => value?.[segment], root);
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
