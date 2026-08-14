import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createController, parseWith, promptForJson } from "../controllers/controller.js";
import { withProgress } from "./terminal.js";

const INSTALLERS = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "bun", "bun.exe", "winget", "winget.exe", "choco", "choco.exe", "scoop", "scoop.cmd", "pipx", "pipx.exe", "cargo", "cargo.exe", "brew"]);
const FORBIDDEN_EXECUTABLES = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash", "zsh", "curl", "wget"]);

export async function runInstaller({ action, name, withModel, controllerId, dryRun = false, execute = false, yes = false, cwd, dataDir, registry, terminal, spawnImpl = spawn }) {
  if (!name) name = await terminal.ask("Quelle CLI veux-tu rechercher ?");
  if (!name) throw new Error("CLI name is required");
  const selected = parseWith(withModel, controllerId || "claude");
  if (controllerId) selected.controller = controllerId;
  const controller = createController({ id: selected.controller, model: selected.model, registry, cwd });

  terminal.phase("Phase 1/4 — recherche de la documentation officielle");
  const plan = await withProgress(terminal, `Recherche de ${name}`, () => promptForJson(controller, installerPrompt(name)));
  validateInstallPlan(plan);
  const planFile = await savePlan(dataDir, plan);

  terminal.phase("Phase 2/4 — vérification du plan d’installation");
  renderInstallPlan(terminal, plan, planFile);
  if (action === "research") {
    terminal.phase("Phase 4/4 — recherche terminée, aucune installation effectuée");
    return { plan, executed: false };
  }

  terminal.phase("Phase 3/4 — attente de validation");
  let approved = false;
  if (!dryRun) {
    approved = execute ? (yes || await terminal.confirm("Exécuter cette commande d’installation ?", false)) : (terminal.interactive && await terminal.confirm("Exécuter cette commande d’installation ?", false));
  }
  if (!approved) {
    terminal.log("\nDry-run terminé. Aucune commande exécutée.");
    terminal.log("Pour exécuter sans dialogue : ajoute --execute --yes après avoir vérifié le plan.");
    terminal.phase("Phase 4/4 — installation non exécutée");
    return { plan, executed: false };
  }

  await runSafeCommand(plan.install, { cwd, spawnImpl, terminal });
  if (plan.verify) await runSafeCommand(plan.verify, { cwd, spawnImpl, terminal, verification: true });
  terminal.phase("Phase 4/4 — installation terminée");
  if (plan.authentication?.steps?.length) {
    terminal.log("\nAuthentification à effectuer :");
    for (const step of plan.authentication.steps) terminal.log(`  - ${step}`);
  }
  terminal.log("ACP Team ne demande ni n’enregistre les clés ou jetons d’authentification.");
  return { plan, executed: true };
}

export function validateInstallPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Invalid installation plan");
  if (plan.sourceType !== "official") throw new Error("Installation refused: the proposed source is not marked official");
  for (const field of ["officialUrl", "sourceUrl"]) {
    const url = new URL(plan[field]);
    if (url.protocol !== "https:") throw new Error(`Installation refused: ${field} must use HTTPS`);
  }
  validateCommand(plan.install, "installation");
  if (plan.verify) validateCommand(plan.verify, "verification");
  return plan;
}

function validateCommand(command, label) {
  if (!command || typeof command.program !== "string") throw new Error(`Missing ${label} program`);
  if (label === "installation" && !INSTALLERS.has(command.program)) throw new Error(`Unsupported ${label} program "${command.program}"`);
  if (label === "verification" && (!/^[a-zA-Z0-9._-]+$/.test(command.program) || FORBIDDEN_EXECUTABLES.has(command.program.toLowerCase()))) {
    throw new Error(`Unsupported ${label} program "${command.program}"`);
  }
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string" || /[\r\n;&|><`]/.test(arg))) {
    throw new Error(`Unsafe ${label} arguments`);
  }
}

function installerPrompt(name) {
  return `Research how to install the ${name} command-line interface on ${process.platform}. Use web research and only the vendor's official documentation or official package registry entry. Keep the information concise. Prefer a package manager installation. Do not propose curl-pipe-shell, PowerShell download-and-execute, sudo, secrets, environment values, or chained commands. The install and verification commands must each be one executable plus an argument array. Supported install programs: ${[...INSTALLERS].join(", ")}. The verification program should be the installed CLI with --version or an equivalent read-only flag. If no supported official installation exists, state that in warnings.\n\nJSON shape:\n{"name":"CLI name","summary":"French summary","officialUrl":"https://...","sourceUrl":"https://...","sourceType":"official","install":{"program":"npm","args":["install","-g","package"]},"verify":{"program":"vendor-cli","args":["--version"]},"authentication":{"method":"OAuth or API key","steps":["short French step"],"storesSecrets":"vendor-managed"},"warnings":["warning"]}`;
}

async function savePlan(dataDir, plan) {
  const directory = path.join(dataDir, "install-plans");
  await mkdir(directory, { recursive: true });
  const id = `install_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const file = path.join(directory, `${id}.json`);
  await writeFile(file, `${JSON.stringify({ ...plan, id, createdAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return file;
}

function renderInstallPlan(terminal, plan, file) {
  terminal.log(`\n${plan.name} — ${plan.summary}`);
  terminal.log(`Source officielle : ${plan.officialUrl}`);
  terminal.log(`Documentation     : ${plan.sourceUrl}`);
  terminal.log(`Installation      : ${renderCommand(plan.install)}`);
  if (plan.verify) terminal.log(`Vérification      : ${renderCommand(plan.verify)}`);
  terminal.log(`Authentification  : ${plan.authentication?.method ?? "non documentée"}`);
  for (const step of plan.authentication?.steps ?? []) terminal.log(`  - ${step}`);
  for (const warning of plan.warnings ?? []) terminal.log(`Attention : ${warning}`);
  terminal.log(`Plan sauvegardé   : ${file}`);
}

function renderCommand(command) {
  return [command.program, ...command.args.map(quoteArgument)].join(" ");
}

function quoteArgument(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function runSafeCommand(command, { cwd, spawnImpl, terminal, verification = false }) {
  terminal.phase(`${verification ? "Vérification" : "Installation"} : ${renderCommand(command)}`);
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" && ["npm", "pnpm", "scoop"].includes(command.program) ? `${command.program}.cmd` : command.program;
    const child = spawnImpl(executable, command.args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command.program} exited with code ${code}`)));
  });
}
