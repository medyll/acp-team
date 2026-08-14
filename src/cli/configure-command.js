import { createConfigManager } from "../config/config-manager.js";
import { createController, parseWith, promptForJson } from "../controllers/controller.js";
import { withProgress } from "./terminal.js";

export async function runConfigure({ objective, withModel, controllerId, apply = false, yes = false, cwd, dataDir, registry, usageManager, terminal, controllerFactory = createController, promptJson = promptForJson }) {
  const config = createConfigManager({ dataDir });
  await config.ensure();
  terminal.phase("Phase 1/6 — lecture de la configuration et des usages");
  const snapshot = await config.inspect();
  const defaults = snapshot.files.settings.controller ?? {};
  const selected = parseWith(withModel, controllerId || defaults.default || "claude");
  if (controllerId) selected.controller = controllerId;
  if (!selected.model && defaults.model && selected.controller === defaults.default) selected.model = defaults.model;

  objective ||= await terminal.ask("Que veux-tu qu’ACP Team configure ?", "Audite la configuration et propose des améliorations utiles");
  terminal.log(`\nContrôleur : ${selected.controller}${selected.model ? ` — modèle : ${selected.model}` : " — modèle par défaut"}`);
  terminal.log(`Objectif    : ${objective}\n`);

  if (/prix|price|tarif|catalog/i.test(objective)) {
    terminal.phase("Phase 2/6 — actualisation des catalogues disponibles");
    const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      try { await usageManager.syncOpenRouter({ apiKey }); }
      catch (error) { terminal.warn(`Catalogue OpenRouter non actualisé : ${error.message}`); }
    } else {
      terminal.phase("Aucune clé OpenRouter : le contrôleur recherchera les informations manquantes avec leurs sources");
    }
  } else {
    terminal.phase("Phase 2/6 — catalogue conservé (aucune actualisation demandée)");
  }

  const controller = controllerFactory({
    id: selected.controller,
    model: selected.model,
    registry,
    cwd,
    onEvent: (event) => event.type === "tool.updated" && terminal.phase(event.title)
  });

  terminal.phase("Phase 3/6 — préparation de l’entretien");
  const interview = await withProgress(terminal, "Le contrôleur prépare ses questions", () =>
    promptJson(controller, interviewPrompt({ objective, snapshot }))
  );
  const answers = {};
  for (const question of (interview.questions ?? []).slice(0, 6)) {
    terminal.log(`\n${question.text}`);
    if (question.why) terminal.log(`  Pourquoi : ${question.why}`);
    answers[question.id] = await terminal.ask("Réponse", String(question.default ?? ""));
  }
  if (interview.assumptions?.length) {
    terminal.log("\nHypothèses proposées :");
    for (const assumption of interview.assumptions) terminal.log(`  - ${assumption}`);
    const accepted = yes || await terminal.confirm("Continuer avec ces hypothèses ?", true);
    if (!accepted) throw new Error("Configuration interrompue avant la proposition");
  }

  terminal.phase("Phase 4/6 — recherche et construction de la proposition");
  const proposal = await withProgress(terminal, "Le contrôleur analyse les options", () =>
    promptJson(controller, proposalPrompt({ objective, snapshot, answers }))
  );
  const staged = await config.stage(proposal);

  terminal.phase("Phase 5/6 — validation locale et aperçu");
  renderProposal(terminal, staged);
  terminal.log(`\nProposition enregistrée : ${staged.id}`);
  terminal.log(`Fichier : ${staged.file}`);

  const mayApply = apply || terminal.interactive;
  const shouldApply = mayApply && (yes || await terminal.confirm("Appliquer cette proposition maintenant ?", false));
  if (!shouldApply) {
    terminal.log(`\nAucun changement appliqué. Pour appliquer : acp-team config apply ${staged.id}`);
    terminal.phase("Phase 6/6 — proposition conservée, configuration inchangée");
    return { proposal: staged, applied: null };
  }
  const applied = await config.apply(staged.id);
  terminal.phase("Phase 6/6 — configuration appliquée et sauvegarde créée");
  terminal.log(`Sauvegarde de rollback : ${applied.backupId}`);
  return { proposal: staged, applied };
}

function interviewPrompt({ objective, snapshot }) {
  return `You are the configuration controller for ACP Team, a control plane that delegates work to coding agents.\nYour first job is to conduct a short, lively interview before proposing changes. Ask only questions whose answers materially affect budgets, model selection, permissions, providers, or interaction defaults. Provide at most 6 questions.\n\nObjective: ${objective}\nCurrent configuration: ${JSON.stringify(snapshot.files)}\n\nJSON shape:\n{"questions":[{"id":"short_id","text":"question in French","why":"one-line reason","default":"safe default"}],"assumptions":["explicit assumption"]}`;
}

function proposalPrompt({ objective, snapshot, answers }) {
  return `You are the configuration controller for ACP Team. Produce a conservative, actionable configuration proposal. You may use web research tools when facts such as model availability or prices can have changed. Prefer official provider sources. Never invent a price. Never include API keys, tokens, secrets, shell commands, or environment-variable values.\n\nObjective: ${objective}\nAnswers: ${JSON.stringify(answers)}\nCurrent configuration: ${JSON.stringify(snapshot.files)}\n\nOnly these files may be changed: settings, budgets, models, providers, promotions, catalog. Every path is relative to that file. Keep the proposal narrow.\n\nJSON shape:\n{"summary":"French summary","rationale":["reason"],"changes":[{"file":"budgets","path":"periods.monthly","value":30,"reason":"why"}],"warnings":["warning"],"sources":[{"url":"https://official.example","title":"source","retrievedAt":"ISO-8601"}]}`;
}

function renderProposal(terminal, proposal) {
  terminal.log(`\n${proposal.summary || "Proposition de configuration"}`);
  if (proposal.rationale?.length) {
    terminal.log("\nRaisons :");
    for (const reason of proposal.rationale) terminal.log(`  - ${reason}`);
  }
  terminal.log("\nChangements :");
  for (const change of proposal.changes) terminal.log(`  - ${change.file}.${change.path} = ${JSON.stringify(change.value)}${change.reason ? ` — ${change.reason}` : ""}`);
  if (proposal.warnings?.length) {
    terminal.log("\nPoints d’attention :");
    for (const warning of proposal.warnings) terminal.log(`  - ${warning}`);
  }
  if (proposal.sources?.length) {
    terminal.log("\nSources :");
    for (const source of proposal.sources) terminal.log(`  - ${source.title || source.url}: ${source.url}`);
  }
}
