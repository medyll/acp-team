import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createController, parseWith, promptForJson } from "../controllers/controller.js";
import { withProgress } from "./terminal.js";

const INSTALLERS = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "bun", "bun.exe", "winget", "winget.exe", "choco", "choco.exe", "scoop", "scoop.cmd", "pipx", "pipx.exe", "cargo", "cargo.exe", "brew"]);
const FORBIDDEN_EXECUTABLES = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash", "zsh", "curl", "wget"]);

export async function runInstaller({ action, name, withModel, controllerId, dryRun = false, execute = false, yes = false, cwd, dataDir, registry, terminal, spawnImpl = spawn, commandTimeoutMs = 10 * 60_000 }) {
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

  await runSafeCommand(plan.install, { cwd, spawnImpl, terminal, timeoutMs: commandTimeoutMs });
  if (plan.verify) await runSafeCommand(plan.verify, { cwd, spawnImpl, terminal, verification: true, timeoutMs: commandTimeoutMs });
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
  if (typeof plan.packageName !== "string" || !plan.packageName.trim()) throw new Error("Installation refused: packageName is required");
  if (typeof plan.publisher !== "string" || !plan.publisher.trim()) throw new Error("Installation refused: publisher is required");
  if (typeof plan.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(plan.version) || ["latest", "next", "canary"].includes(plan.version.toLowerCase())) {
    throw new Error("Installation refused: an explicit non-floating version is required");
  }
  for (const field of ["officialUrl", "sourceUrl"]) {
    const url = new URL(plan[field]);
    if (url.protocol !== "https:") throw new Error(`Installation refused: ${field} must use HTTPS`);
  }
  if (!Array.isArray(plan.evidence) || !plan.evidence.length || plan.evidence.length > 5) throw new Error("Installation refused: 1-5 provenance evidence URLs are required");
  const officialHost = new URL(plan.officialUrl).hostname;
  const evidenceUrls = plan.evidence.map((value) => new URL(value));
  if (evidenceUrls.some((url) => url.protocol !== "https:")) throw new Error("Installation refused: provenance evidence must use HTTPS");
  if (!evidenceUrls.some((url) => url.hostname === officialHost)) throw new Error("Installation refused: provenance must include the official domain");
  validateCommand(plan.install, "installation");
  if (!plan.install.args.some((arg) => arg.includes(plan.version))) throw new Error("Installation refused: command must pin the proposed version");
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
  return `Research how to install the ${name} command-line interface on ${process.platform}. Use web research and only the vendor's official documentation or official package registry entry. Establish the package owner from the official vendor domain and cite 1-5 HTTPS evidence URLs including that domain. Keep the information concise. Pin one explicit stable version; never use latest, next or canary. Prefer a package manager installation. Do not propose curl-pipe-shell, PowerShell download-and-execute, sudo, secrets, environment values, or chained commands. The install and verification commands must each be one executable plus an argument array. Supported install programs: ${[...INSTALLERS].join(", ")}. The verification program should be the installed CLI with --version or an equivalent read-only flag. If provenance cannot be established, do not invent it and state that in warnings.\n\nJSON shape:\n{"name":"CLI name","packageName":"registry package","publisher":"verified publisher","version":"1.2.3","summary":"French summary","officialUrl":"https://vendor.example","sourceUrl":"https://registry.example/package","evidence":["https://vendor.example/install"],"sourceType":"official","install":{"program":"npm","args":["install","-g","package@1.2.3"]},"verify":{"program":"vendor-cli","args":["--version"]},"authentication":{"method":"OAuth or API key","steps":["short French step"],"storesSecrets":"vendor-managed"},"warnings":["warning"]}`;
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
  terminal.log(`Paquet/version    : ${plan.packageName}@${plan.version} (${plan.publisher})`);
  for (const evidence of plan.evidence) terminal.log(`Preuve             : ${evidence}`);
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

function runSafeCommand(command, { cwd, spawnImpl, terminal, verification = false, timeoutMs }) {
  terminal.phase(`${verification ? "Vérification" : "Installation"} : ${renderCommand(command)}`);
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" && ["npm", "pnpm", "scoop"].includes(command.program) ? `${command.program}.cmd` : command.program;
    const child = spawnImpl(executable, command.args, { cwd, stdio: "inherit", shell: false });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${command.program} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => code === 0 ? resolve() : reject(new Error(`${command.program} exited with code ${code}`))));
  });
}
