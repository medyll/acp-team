import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runConfigure } from "./configure-command.js";

test("conducts an interview and stages without applying by default", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "acp-team-configure-"));
  const messages = [];
  const confirmations = [true, false];
  const terminal = {
    interactive: true,
    phase: (message) => messages.push(message),
    log: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    ask: async (message, fallback) => message === "Réponse" ? "25 USD" : fallback,
    confirm: async () => confirmations.shift()
  };
  const replies = [
    { questions: [{ id: "budget", text: "Quel budget ?", default: "20 USD" }], assumptions: ["lecture seule"] },
    { summary: "Budget ajusté", rationale: ["demande"], changes: [{ file: "budgets", path: "periods.monthly", value: 25 }] }
  ];
  const result = await runConfigure({
    objective: "Réduire les coûts",
    withModel: "opus",
    cwd: process.cwd(), dataDir,
    registry: {},
    usageManager: { syncOpenRouter: async () => {} },
    terminal,
    controllerFactory: ({ id, model }) => ({ id, model }),
    promptJson: async () => replies.shift()
  });
  assert.equal(result.proposal.changes[0].value, 25);
  assert.equal(result.applied, null);
  assert(messages.some((message) => String(message).includes("Aucun changement appliqué")));
});
