#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRegistry } from "./agents/registry.js";
import { createTerminal } from "./cli/terminal.js";
import { runConfigure } from "./cli/configure-command.js";
import { runInstaller } from "./cli/installer-command.js";
import { createConfigManager } from "./config/config-manager.js";
import { createUsageManager } from "./usage/usage-manager.js";

export async function main(argv, terminal = createTerminal()) {
  const { positionals, options } = parseArguments(argv);
  const [command, subcommand, ...rest] = positionals;
  if (["help", "--help", "-h"].includes(command)) return terminal.log(HELP);
  if (["version", "--version", "-v"].includes(command)) return terminal.log("acp-team 1.0.5");

  const cwd = path.resolve(options.cwd || process.env.AGENT_BRIDGE_CWD || process.cwd());
  const dataDir = path.resolve(options["data-dir"] || process.env.AGENT_BRIDGE_DATA_DIR || path.join(cwd, ".acp-team"));
  const log = (message) => options.verbose && terminal.phase(message);
  const registry = createRegistry({ log });
  const usageManager = createUsageManager({ dataDir });
  const configManager = createConfigManager({ dataDir });
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
      return runPrompt({ prompt: positionals.slice(1).join(" "), options, cwd, registry, terminal });
    case "chat":
      return runChat({ options, cwd, registry, terminal });
    case "agent":
      return runAgent({ subcommand, name: rest[0], registry, terminal });
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

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  const booleans = new Set(["apply", "yes", "dry-run", "execute", "json", "verbose", "new-session"]);
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

async function runPrompt({ prompt, options, cwd, registry, terminal }) {
  const agent = options.to;
  if (!agent) throw new Error("`prompt` requires --to <agent>");
  prompt ||= await terminal.ask("Prompt");
  if (!prompt) throw new Error("Prompt is required");
  terminal.phase(`Envoi à ${agent}…`);
  const result = await registry.get(agent).ask({ prompt, cwd, model: options.model, mode: options.mode || "plan", newSession: options["new-session"] });
  terminal.log(result.text || `(${agent} n’a retourné aucun texte)`);
}

async function runChat({ options, cwd, registry, terminal }) {
  if (!terminal.interactive) throw new Error("`chat` requires an interactive terminal");
  const agent = options.with ?? options.avec ?? options.to;
  if (!agent) throw new Error("`chat` requires --with <agent>");
  terminal.log(`Conversation avec ${agent}. Tape /exit pour terminer.`);
  while (true) {
    const prompt = await terminal.ask("Vous");
    if (["/exit", "/quit"].includes(prompt)) break;
    if (!prompt) continue;
    terminal.phase(`${agent} réfléchit…`);
    const result = await registry.get(agent).ask({ prompt, cwd, model: options.model, mode: options.mode || "default" });
    terminal.log(`\n${agent}> ${result.text}\n`);
  }
}

async function runAgent({ subcommand = "list", name, registry, terminal }) {
  if (subcommand === "list") return terminal.log(JSON.stringify(registry.list().map(({ id, description, modes }) => ({ id, description, modes })), null, 2));
  if (subcommand === "status") {
    const adapters = name ? [registry.get(name)] : registry.list();
    return terminal.log(JSON.stringify(await Promise.all(adapters.map((adapter) => adapter.status())), null, 2));
  }
  throw new Error("Agent commands: list, status [name]");
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
  if (subcommand !== "recommend") throw new Error("Model command currently available: recommend <task>");
  terminal.log(JSON.stringify(await usageManager.recommend({ task, profile: options.profile || "auto" }), null, 2));
}

async function runBudget({ subcommand, options, usageManager, terminal }) {
  if (subcommand !== "check") throw new Error("Budget command currently available: check");
  terminal.log(JSON.stringify(await usageManager.check({ profile: options.profile, estimatedCost: options.cost === undefined ? undefined : Number(options.cost), currency: options.currency }), null, 2));
}

function parseValue(value) {
  try { return JSON.parse(value); } catch { return value; }
}

const HELP = `acp-team — piloter et configurer une équipe de LLM\n\nUsage:\n  acp-team                         Démarrer le serveur MCP (compatibilité)\n  acp-team serve                   Démarrer explicitement le serveur MCP\n  acp-team configure [objectif] [--with modèle|--avec modèle] [--controller agent] [--apply]\n  acp-team config show|get|set|validate|diff|apply|rollback\n  acp-team prompt <texte> --to <agent> [--model modèle] [--mode plan|default|auto|yolo]\n  acp-team chat --with <agent>\n  acp-team cli research <nom> [--with modèle]\n  acp-team cli install <nom> [--dry-run|--execute --yes]\n  acp-team agent list|status [nom]\n  acp-team usage status|report|sync\n  acp-team model recommend <tâche>\n  acp-team budget check --profile <profil> --cost <montant>\n\nSécurité:\n  configure demande confirmation avant application ; un script exige --apply --yes.\n  cli install montre toujours la source, la commande et l’authentification avant exécution.`;

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
