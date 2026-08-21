#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRegistry } from "./agents/registry.js";
import { createTerminal } from "./cli/terminal.js";
import { runConfigure } from "./cli/configure-command.js";
import { runInstaller } from "./cli/installer-command.js";
import { createConfigManager } from "./config/config-manager.js";
import { createUsageManager } from "./usage/usage-manager.js";
import { runtimeFromEnvironment } from "./config/runtime-config.js";
import { createAuthorizationManager } from "./security/authorization-manager.js";
import { authorizeMode, requiresWriteAuthorization } from "./security-policy.js";
import { diagnose, repair } from "./doctor.js";
import { checkCompatibility } from "./compatibility-check.js";
import { createRunJournal } from "./runs/run-journal.js";
import { validateAgentDefinition } from "./agents/declarative-adapter.js";

export async function main(argv, terminal = createTerminal()) {
  const { positionals, options } = parseArguments(argv);
  const [command, subcommand, ...rest] = positionals;
  if (["help", "--help", "-h"].includes(command)) return terminal.log(HELP);
  if (["version", "--version", "-v"].includes(command)) return terminal.log("acp-team 1.0.5");

  const cwd = path.resolve(options.cwd || process.env.AGENT_BRIDGE_CWD || process.cwd());
  // The store lives with the bridge, not with the directory an agent is scoped to:
  // `--cwd` moves the agent's working directory only, so a token granted for another
  // project still lands in the store the MCP server reads.
  const bridgeDir = path.resolve(process.env.AGENT_BRIDGE_CWD || process.cwd());
  const dataDir = path.resolve(options["data-dir"] || process.env.AGENT_BRIDGE_DATA_DIR || path.join(bridgeDir, ".acp-team"));
  const log = (message) => options.verbose && terminal.phase(message);
  const configManager = createConfigManager({ dataDir });
  const runtimeConfig = ["config", "authorize", "run"].includes(command)
    ? runtimeFromEnvironment()
    : runtimeFromEnvironment(await configManager.runtime());
  const needsRegistry = !["config", "authorize", "usage", "model", "budget", "run"].includes(command);
  const registry = needsRegistry ? createRegistry({ log, runtime: runtimeConfig }) : null;
  const usageManager = createUsageManager({
    dataDir,
    timeoutMs: runtimeConfig.resilience.httpTimeoutMs,
    maxResponseBytes: runtimeConfig.resilience.maxResponseBytes,
    retryOptions: { attempts: runtimeConfig.resilience.retryAttempts }
  });
  const authorizationManager = createAuthorizationManager({ dataDir });
  await usageManager.ensure();

  switch (command) {
    case "configure":
      return runConfigure({
        objective: positionals.slice(1).join(" "),
        withModel: options.with ?? options.avec,
        controllerId: options.controller,
        apply: options.apply,
        yes: options.yes,
        cwd, dataDir, registry, usageManager, terminal
      });
    case "config":
      return runConfig({ subcommand, args: rest, options, configManager, terminal });
    case "cli":
      if (!["research", "install"].includes(subcommand)) throw new Error("Use `acp-team cli research <name>` or `acp-team cli install <name>`");
      return runInstaller({
        action: subcommand,
        name: rest.join(" "),
        withModel: options.with ?? options.avec,
        controllerId: options.controller,
        dryRun: options["dry-run"],
        execute: options.execute,
        yes: options.yes,
        cwd, dataDir, registry, terminal
      });
    case "prompt":
      return runPrompt({ prompt: positionals.slice(1).join(" "), options, cwd, registry, authorizationManager, terminal });
    case "chat":
      return runChat({ options, cwd, registry, authorizationManager, terminal });
    case "authorize":
      return runAuthorize({ subcommand, args: rest, options, cwd, authorizationManager, terminal });
    case "doctor": {
      if (options.fix) {
        const approved = options.yes || await terminal.confirm("Migrer et normaliser la configuration ?", false);
        if (approved) terminal.log(JSON.stringify(await repair({ configManager }), null, 2));
      }
      return terminal.log(JSON.stringify(await diagnose({ configManager, registry, dataDir, agent: options.agent, stopAfter: true }), null, 2));
    }
    case "compat":
      if (subcommand !== "test") throw new Error("Compatibility command: compat test [agent] [--live]");
      return terminal.log(JSON.stringify(await checkCompatibility({ registry, cwd, agents: rest.length ? rest : undefined, live: options.live ?? false }), null, 2));
    case "run":
      return runHistoryCommand({ subcommand, args: rest, options, dataDir, terminal });
    case "agent":
      return runAgent({ subcommand, name: rest[0], options, registry, configManager, runtimeConfig, terminal });
    case "usage":
      return runUsage({ subcommand, options, usageManager, terminal });
    case "model":
      return runModel({ subcommand, task: rest.join(" "), options, usageManager, terminal });
    case "budget":
      return runBudget({ subcommand, options, usageManager, terminal });
    default:
      throw new Error(`Commande inconnue "${command}". Utilise acp-team help.`);
  }
}

async function runHistoryCommand({ subcommand = "history", args, options, dataDir, terminal }) {
  const journal = createRunJournal({ dataDir });
  if (subcommand === "history") {
    const entries = await journal.history({ limit: options.limit ? Number(options.limit) : 100 });
    return terminal.log(JSON.stringify(options.agent ? entries.filter((entry) => entry.agent === options.agent) : entries, null, 2));
  }
  if (subcommand === "show") {
    if (!args[0]) throw new Error("Usage: acp-team run show <run-id>");
    return terminal.log(JSON.stringify(await journal.history({ runId: args[0], limit: 1000 }), null, 2));
  }
  if (subcommand === "retry") throw new Error("run retry is available through MCP while the original run is retained; prompts are not persisted across CLI processes");
  throw new Error("Run commands: history, show <run-id>");
}

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  const booleans = new Set(["apply", "yes", "dry-run", "execute", "json", "verbose", "new-session", "fix", "live", "enable"]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2);
    const name = rawName === "avec" ? "avec" : rawName;
    if (inline !== undefined) options[name] = inline;
    else if (booleans.has(name)) options[name] = true;
    else {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`Option --${name} requires a value`);
      options[name] = argv[++index];
    }
  }
  return { positionals, options };
}

async function runConfig({ subcommand = "show", args, options, configManager, terminal }) {
  switch (subcommand) {
    case "show":
      terminal.log(JSON.stringify(await configManager.inspect(), null, 2));
      break;
    case "path":
      terminal.log(configManager.dataDir);
      break;
    case "get": {
      if (!args[0]) throw new Error("Usage: acp-team config get <key>");
      terminal.log(JSON.stringify(await configManager.get(args[0]), null, 2));
      break;
    }
    case "set": {
      if (!args[0] || args[1] === undefined) throw new Error("Usage: acp-team config set <key> <value>");
      const value = parseValue(args.slice(1).join(" "));
      terminal.log(JSON.stringify(await configManager.set(args[0], value), null, 2));
      break;
    }
    case "validate":
      await configManager.inspect();
      terminal.log("Configuration valide.");
      break;
    case "diff":
      terminal.log(JSON.stringify(await configManager.loadProposal(args[0]), null, 2));
      break;
    case "apply": {
      if (!args[0]) throw new Error("Usage: acp-team config apply <proposal-id>");
      const approved = options.yes || await terminal.confirm(`Appliquer ${args[0]} ?`, false);
      if (!approved) return terminal.log("Aucun changement appliqué.");
      terminal.log(JSON.stringify(await configManager.apply(args[0]), null, 2));
      break;
    }
    case "rollback": {
      if (!args[0]) throw new Error("Usage: acp-team config rollback <backup-id>");
      const approved = options.yes || await terminal.confirm(`Restaurer ${args[0]} ?`, false);
      if (!approved) return terminal.log("Aucun changement appliqué.");
      terminal.log(JSON.stringify(await configManager.rollback(args[0]), null, 2));
      break;
    }
    default:
      throw new Error("Config commands: show, path, get, set, validate, diff, apply, rollback");
  }
}

async function runPrompt({ prompt, options, cwd, registry, authorizationManager, terminal }) {
  const agent = options.to;
  if (!agent) throw new Error("`prompt` requires --to <agent>");
  prompt ||= await terminal.ask("Prompt");
  if (!prompt) throw new Error("Prompt is required");
  terminal.phase(`Envoi à ${agent}…`);
  const mode = authorizeMode(options.mode);
  if (requiresWriteAuthorization(mode)) await authorizationManager.consume({ token: options.authorization, agent, cwd, mode });
  const result = await registry.get(agent).ask({ prompt, cwd, model: options.model, mode, newSession: options["new-session"] });
  terminal.log(result.text || `(${agent} n’a retourné aucun texte)`);
}

async function runChat({ options, cwd, registry, authorizationManager, terminal }) {
  if (!terminal.interactive) throw new Error("`chat` requires an interactive terminal");
  const agent = options.with ?? options.avec ?? options.to;
  if (!agent) throw new Error("`chat` requires --with <agent>");
  terminal.log(`Conversation avec ${agent}. Tape /exit pour terminer.`);
  const mode = authorizeMode(options.mode);
  while (true) {
    const prompt = await terminal.ask("Vous");
    if (["/exit", "/quit"].includes(prompt)) break;
    if (!prompt) continue;
    if (requiresWriteAuthorization(mode)) await authorizationManager.consume({ token: options.authorization, agent, cwd, mode });
    terminal.phase(`${agent} réfléchit…`);
    const result = await registry.get(agent).ask({ prompt, cwd, model: options.model, mode });
    terminal.log(`\n${agent}> ${result.text}\n`);
  }
}

async function runAuthorize({ subcommand = "list", args, options, cwd, authorizationManager, terminal }) {
  if (subcommand === "list") return terminal.log(JSON.stringify(await authorizationManager.list(), null, 2));
  if (subcommand === "revoke") {
    if (!args[0]) throw new Error("Usage: acp-team authorize revoke <id>");
    return terminal.log(JSON.stringify(await authorizationManager.revoke(args[0]), null, 2));
  }
  if (subcommand !== "grant") throw new Error("Authorize commands: grant, list, revoke");
  if (!options.agent) throw new Error("authorize grant requires --agent <agent>");
  if (!options.yes && !terminal.interactive) throw new Error("authorize grant requires --yes in a non-interactive terminal");
  const approved = options.yes || await terminal.confirm(`Autoriser ${options.agent} à écrire dans ${cwd} ?`, false);
  if (!approved) return terminal.log("Autorisation non créée.");
  const issued = await authorizationManager.issue({
    agent: options.agent,
    cwd,
    mode: options.mode || "default",
    ttlMs: parseDuration(options.for || "15m"),
    uses: options.uses ? Number(options.uses) : 1
  });
  terminal.log(JSON.stringify(issued, null, 2));
}

function parseDuration(value) {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error("Duration must look like 30s, 15m or 2h");
  return Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000 }[match[2]]);
}

async function runAgent({ subcommand = "list", name, options, registry, configManager, runtimeConfig, terminal }) {
  if (subcommand === "list") return terminal.log(JSON.stringify(registry.list().map(({ id, description, modes }) => ({ id, description, modes })), null, 2));
  if (subcommand === "status") {
    const adapters = name ? [registry.get(name)] : registry.list();
    return terminal.log(JSON.stringify(await Promise.all(adapters.map((adapter) => adapter.status())), null, 2));
  }
  if (subcommand === "probe") {
    if (!name) throw new Error("Usage: acp-team agent probe <name>");
    return terminal.log(JSON.stringify(await registry.get(name).status(), null, 2));
  }
  if (subcommand === "add") {
    const definition = validateAgentDefinition({
      id: name,
      transport: "acp",
      command: options.command,
      args: options.args ? parseValue(options.args) : ["acp"],
      description: options.description,
      model: options.model,
      mode: options.mode || "plan",
      permission: options.permission || "deny"
    });
    const approved = options.yes || await terminal.confirm(`Ajouter l’agent ACP ${name} (${definition.command}) ?`, false);
    if (!approved) return terminal.log("Agent non ajouté.");
    const customAgents = [...runtimeConfig.customAgents.filter((entry) => entry.id !== name), definition];
    await configManager.set("runtime.customAgents", customAgents);
    if (options.enable) await enableAgent(configManager, runtimeConfig, name);
    return terminal.log(JSON.stringify({ added: name, enabled: Boolean(options.enable), restartRequired: true }, null, 2));
  }
  if (subcommand === "enable") {
    if (!name) throw new Error("Usage: acp-team agent enable <name>");
    await enableAgent(configManager, runtimeConfig, name);
    return terminal.log(JSON.stringify({ enabled: name, restartRequired: true }, null, 2));
  }
  throw new Error("Agent commands: list, status, probe, add, enable");
}

async function enableAgent(configManager, runtimeConfig, name) {
  const known = new Set(["kimi", "codex", "opencode", "ollama", ...runtimeConfig.customAgents.map((entry) => entry.id)]);
  if (!known.has(name)) throw new Error(`Unknown agent "${name}"`);
  const enabled = runtimeConfig.enabledAgents ?? ["kimi", "codex", "opencode", "ollama"];
  await configManager.set("runtime.enabledAgents", [...new Set([...enabled, name])]);
}

async function runUsage({ subcommand = "status", options, usageManager, terminal }) {
  const input = { period: options.period, agent: options.agent, model: options.model };
  if (subcommand === "status") return terminal.log(JSON.stringify(await usageManager.status(input), null, 2));
  if (subcommand === "report") return terminal.log(JSON.stringify(await usageManager.report(input), null, 2));
  if (subcommand === "sync") {
    const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_API_KEY;
    return terminal.log(JSON.stringify(await usageManager.syncOpenRouter({ apiKey }), null, 2));
  }
  throw new Error("Usage commands: status, report, sync");
}

async function runModel({ subcommand, task, options, usageManager, terminal }) {
  if (subcommand === "recommend") return terminal.log(JSON.stringify(await usageManager.recommend({ task, profile: options.profile || "auto" }), null, 2));
  if (subcommand === "ratings") return terminal.log(JSON.stringify(await usageManager.ratings({ agent: options.agent, model: options.model }), null, 2));
  if (subcommand === "rate") {
    return terminal.log(JSON.stringify(await usageManager.rate({
      runId: options.run,
      agent: options.agent,
      model: options.model,
      rating: Number(options.rating),
      note: options.note
    }), null, 2));
  }
  throw new Error("Model commands: recommend <task>, rate, ratings");
}

async function runBudget({ subcommand, options, usageManager, terminal }) {
  if (subcommand !== "check") throw new Error("Budget command currently available: check");
  terminal.log(JSON.stringify(await usageManager.check({ profile: options.profile, estimatedCost: options.cost === undefined ? undefined : Number(options.cost), currency: options.currency }), null, 2));
}

function parseValue(value) {
  try { return JSON.parse(value); } catch { return value; }
}

const HELP = `acp-team — piloter et configurer une équipe de LLM\n\nUsage:\n  acp-team                         Démarrer le serveur MCP (compatibilité)\n  acp-team serve                   Démarrer explicitement le serveur MCP\n  acp-team doctor [--agent nom] [--fix]\n  acp-team configure [objectif] [--with modèle|--avec modèle] [--controller agent] [--apply]\n  acp-team config show|get|set|validate|diff|apply|rollback\n  acp-team authorize grant|list|revoke\n  acp-team prompt <texte> --to <agent> [--model modèle] [--mode plan|default|auto]\n  acp-team chat --with <agent>\n  acp-team cli research <nom> [--with modèle]\n  acp-team cli install <nom> [--dry-run|--execute --yes]\n  acp-team agent list|status|probe|add|enable\n  acp-team run history|show|retry\n  acp-team compat test [agent] [--live]\n  acp-team usage status|report|sync\n  acp-team model recommend|rate|ratings\n  acp-team budget check --profile <profil> --cost <montant>\n\nSécurité:\n  les modes d’écriture exigent un jeton temporaire créé par authorize grant.\n  configure demande confirmation avant application ; un script exige --apply --yes.\n  cli install exige une version épinglée et des preuves de provenance avant exécution.`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "serve") {
    await import("./mcp-server.js");
  } else {
    const terminal = createTerminal();
    try {
      await main(argv, terminal);
    } catch (error) {
      terminal.warn(`Erreur : ${error.message}`);
      process.exitCode = 1;
    } finally {
      terminal.close();
    }
  }
}
