import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_TTL_MS = 24 * 60 * 60_000;

export function createAuthorizationManager({ dataDir, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error("Authorization manager requires a dataDir");
  const file = path.join(dataDir, "authorizations.json");
  let tail = Promise.resolve();

  function issue(options) {
    return exclusive(() => issueUnlocked(options));
  }

  async function issueUnlocked({ agent, cwd, mode = "default", ttlMs = 15 * 60_000, uses = 1 } = {}) {
    if (!agent || !cwd) throw new Error("Authorization requires agent and cwd");
    if (!["default", "auto"].includes(mode)) throw new Error("Authorization mode must be default or auto");
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) throw new Error("Authorization uses must be between 1 and 100");
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new Error("Authorization lifetime must be between 1 second and 24 hours");
    const token = `auth_${randomBytes(24).toString("base64url")}`;
    const entries = await load();
    const entry = {
      id: randomUUID(),
      tokenHash: hash(token),
      agent,
      cwd: path.resolve(cwd),
      mode,
      createdAt: now().toISOString(),
      expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
      usesRemaining: uses,
      revokedAt: null
    };
    entries.push(entry);
    await save(entries);
    return { token, authorization: publicEntry(entry) };
  }

  function consume(options) {
    return exclusive(() => consumeUnlocked(options));
  }

  async function consumeUnlocked({ token, agent, cwd, mode }) {
    if (!["default", "auto"].includes(mode)) return { required: false };
    if (!token) throw new Error("Write-capable mode requires a scoped authorization token");
    const entries = await load();
    const entry = entries.find((candidate) => candidate.tokenHash === hash(token));
    if (!entry || entry.revokedAt) throw new Error("Authorization token is invalid or revoked");
    if (new Date(entry.expiresAt) <= now()) throw new Error("Authorization token has expired");
    if (entry.usesRemaining < 1) throw new Error("Authorization token has no remaining uses");
    if (entry.agent !== "*" && entry.agent !== agent) throw new Error(`Authorization is scoped to agent ${entry.agent}`);
    if (path.resolve(cwd) !== entry.cwd) throw new Error(`Authorization is scoped to ${entry.cwd}`);
    if (entry.mode !== mode) throw new Error(`Authorization is scoped to mode ${entry.mode}`);
    entry.usesRemaining -= 1;
    await save(entries);
    return publicEntry(entry);
  }

  function revoke(id) {
    return exclusive(() => revokeUnlocked(id));
  }

  async function revokeUnlocked(id) {
    const entries = await load();
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown authorization "${id}"`);
    entry.revokedAt = now().toISOString();
    await save(entries);
    return publicEntry(entry);
  }

  async function list() {
    await tail;
    return (await load()).map(publicEntry);
  }

  function exclusive(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  }

  async function load() {
    try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`Invalid authorization store: ${error.message}`);
    }
  }

  async function save(entries) {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  return { issue, consume, revoke, list, file };
}

function hash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function publicEntry({ tokenHash: _tokenHash, ...entry }) {
  return entry;
}
