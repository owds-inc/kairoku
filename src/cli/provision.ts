/**
 * The machine steps of `kairoku setup --daemon`, ported one for one from the
 * bash script (and, before it, orch/setup-agent-vm.sh in the planning repo).
 * Each step is idempotent and safe on a live machine: it installs only what
 * is missing, never upgrades a runtime out from under a running agent, and
 * hands back the exact commands when it cannot do a step itself.
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { kairokuHome } from "../daemon/config";
import { version, type Io } from "./io";

export type Step = { name: string; outcome: "done" | "skipped" | "manual"; detail: string };
const done = (name: string, detail: string): Step => ({ name, outcome: "done", detail });
const skipped = (name: string, detail: string): Step => ({ name, outcome: "skipped", detail });
const manual = (name: string, detail: string): Step => ({ name, outcome: "manual", detail });

export const NODE_MAJOR = 24;

/**
 * The app checkout the daemon cuts worktrees from. DECISIONS §18: the app is
 * moving to a GitLab project under https://gitlab.com/owds-inc/kairoku/ — that
 * project does not exist yet, so v0.1 defaults to where the app lives today.
 * Switching this constant is the recorded follow-up. The operator's choice is
 * persisted as `repoUrl` in config.json, so a rerun never asks again.
 */
export const DEFAULT_APP_REPO = "https://github.com/bikerwhocodes/kairoku.git";

export const CODEX_MCP_ADD =
  "timeout 15 codex mcp add kairoku --url https://kairoku.io/api/mcp --bearer-token-env-var KAIROKU_PAT";

const sudoOk = async (io: Io) => (await io.shell(["sudo", "-n", "true"])).code === 0;

/** Make a freshly installed tool visible to the rest of this run. */
function prependPath(io: Io, dir: string) {
  if (!dir) return;
  const current = io.env.PATH ?? "";
  if (!current.split(":").includes(dir)) io.env.PATH = current ? `${dir}:${current}` : dir;
}

export async function runtimes(io: Io): Promise<Step[]> {
  const steps: Step[] = [];

  const node = await version(io, "node");
  const major = Number(node?.replace(/^v/, "").split(".")[0]);
  if (major >= NODE_MAJOR) {
    steps.push(skipped("node", `${node} already ≥ ${NODE_MAJOR} — not upgrading`));
  } else {
    const install = await io.shell(
      ["bash", "-c", `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install ${NODE_MAJOR}`],
      { live: true },
    );
    if (install.code === 0) {
      const which = await io.shell(["bash", "-c", `. "$HOME/.nvm/nvm.sh" && nvm which ${NODE_MAJOR}`]);
      if (which.code === 0 && which.stdout.trim()) prependPath(io, dirname(which.stdout.trim()));
      steps.push(done("node", `installed node ${NODE_MAJOR} through nvm`));
    } else {
      steps.push(manual("node", `nvm install failed (exit ${install.code}) — install node ≥ ${NODE_MAJOR} by hand`));
    }
  }

  if (io.which("bun")) {
    steps.push(skipped("bun", `${await version(io, "bun")} already installed`));
  } else {
    const install = await io.shell(["bash", "-c", "curl -fsSL https://bun.sh/install | bash"], { live: true });
    prependPath(io, join(io.home, ".bun", "bin"));
    steps.push(install.code === 0 ? done("bun", "installed from bun.sh") : manual("bun", `install failed (exit ${install.code})`));
  }

  // Only what is missing. This is provisioning, not an update channel: a rerun
  // on a live machine must not swap the CLI versions out from under a run.
  const want: Record<string, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", paseo: "@getpaseo/cli" };
  const missing = Object.entries(want).filter(([bin]) => !io.which(bin)).map(([, pkg]) => pkg);
  if (missing.length === 0) {
    steps.push(skipped("agent CLIs", "claude, codex, paseo all present"));
  } else {
    const install = await io.shell(["npm", "install", "-g", ...missing], { live: true });
    steps.push(install.code === 0 ? done("agent CLIs", `npm install -g ${missing.join(" ")}`) : manual("agent CLIs", `npm install -g ${missing.join(" ")} failed (exit ${install.code})`));
  }
  return steps;
}

/**
 * Ubuntu's .bashrc returns early for non-interactive shells, and nvm's own
 * PATH lines sit BELOW that guard — so they never run for `ssh host cmd`,
 * which is how every remote command arrives. The export has to be the FIRST
 * line of .bashrc, above the guard.
 */
export async function shellPath(io: Io): Promise<Step> {
  const name = "non-interactive PATH";
  if (io.platform !== "linux") return skipped(name, "not needed on mac — the launchd agent carries its own PATH");
  const bashrc = join(io.home, ".bashrc");
  const current = io.readFile(bashrc) ?? "";
  if (current.includes(".bun/bin")) return skipped(name, "export already above the interactive guard");
  const node = io.which("node");
  const dirs = [join(io.home, ".bun", "bin"), node ? dirname(node) : ""].filter(Boolean).join(":");
  io.writeFile(bashrc, `export PATH="${dirs}:$PATH"\n${current}`);
  return done(name, "prepended to ~/.bashrc line 1");
}

export const appCheckoutDir = (io: Io) => join(io.home, "work", "kairoku");

export async function checkout(io: Io, repoUrl: string): Promise<Step> {
  const name = "app checkout (worktree base)";
  const dir = appCheckoutDir(io);
  const present = io.exists(join(dir, ".git"));
  if (!present) {
    const clone = await io.shell(["git", "clone", repoUrl, dir], { live: true });
    if (clone.code !== 0) return manual(name, `git clone ${repoUrl} failed: ${clone.stderr.trim() || `exit ${clone.code}`}`);
  }
  const install = await io.shell(["bun", "install", "--cwd", dir], { live: true });
  const note = install.code === 0 ? "" : " (bun install reported a problem)";
  return present ? skipped(name, `already at ${dir}${note}`) : done(name, `cloned ${repoUrl} into ${dir}${note}`);
}

/**
 * Ubuntu 24.04+ restricts unprivileged user namespaces; codex exec's sandbox
 * (bubblewrap) then fails with "bwrap: loopback: Failed RTM_NEWADDR".
 */
export async function userns(io: Io): Promise<Step> {
  const name = "user namespaces (codex sandbox)";
  if (io.platform !== "linux") return skipped(name, "no such knob on mac");
  if (!(await sudoOk(io))) {
    return manual(
      name,
      "no passwordless sudo — run by hand:\n" +
        "     sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
        "     echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/99-codex-userns.conf",
    );
  }
  const knob = io.readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim();
  if (knob === undefined) return skipped(name, "sysctl key absent on this kernel");
  if (knob === "0" && io.exists("/etc/sysctl.d/99-codex-userns.conf")) return skipped(name, "already 0 and persisted");
  await io.shell(["sudo", "sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"]);
  await io.shell(["sudo", "sh", "-c", "echo kernel.apparmor_restrict_unprivileged_userns=0 > /etc/sysctl.d/99-codex-userns.conf"]);
  return done(name, "set to 0 and persisted in /etc/sysctl.d/99-codex-userns.conf");
}

/**
 * approval_policy "never" auto-DENIES approval requests, and a Kairoku MCP
 * write generates one unless the server's mode is "approve" (pre-approved).
 * "auto" is NOT enough — writes still prompt, and then get denied.
 */
export async function codexConfig(io: Io): Promise<Step> {
  const name = "codex MCP approval mode";
  const path = join(io.home, ".codex", "config.toml");
  const text = io.readFile(path);
  if (text === null) return manual(name, "no ~/.codex/config.toml yet — run `codex login`, add the kairoku MCP server, then rerun `kairoku setup --daemon`");
  if (text.includes("default_tools_approval_mode")) return skipped(name, "default_tools_approval_mode already set");
  if (!text.includes('bearer_token_env_var = "KAIROKU_PAT"')) {
    return manual(name, `kairoku MCP entry not found in ${path} — add it with:\n     ${CODEX_MCP_ADD}\n     (the add command hangs after writing; the config still lands), then rerun`);
  }
  io.writeFile(path, text.replace(/^(bearer_token_env_var = "KAIROKU_PAT")$/m, '$1\ndefault_tools_approval_mode = "approve"'));
  return done(name, 'default_tools_approval_mode = "approve"');
}

/** The machine's LAN address — what the daemon binds (never 0.0.0.0). */
export async function lanIp(io: Io): Promise<string> {
  const r = io.platform === "linux" ? await io.shell(["hostname", "-I"]) : await io.shell(["ipconfig", "getifaddr", "en0"]);
  return (r.code === 0 && r.stdout.trim().split(/\s+/)[0]) || "127.0.0.1";
}

export function configuredRepoUrl(io: Io): string | undefined {
  try {
    const parsed = JSON.parse(io.readFile(join(kairokuHome(io.home), "config.json")) ?? "{}") as { repoUrl?: unknown };
    return typeof parsed.repoUrl === "string" ? parsed.repoUrl : undefined;
  } catch {
    return undefined;
  }
}

export async function daemonConfig(io: Io, repoPath: string, repoUrl?: string): Promise<Step[]> {
  const dir = kairokuHome(io.home);
  const tokenPath = join(dir, "token.env");
  const configPath = join(dir, "config.json");
  const steps: Step[] = [];
  if (io.exists(tokenPath)) {
    steps.push(skipped("bearer token", "already present (not shown, not regenerated)"));
  } else {
    io.writeFile(tokenPath, `KAIROKU_DAEMON_TOKEN=${randomBytes(32).toString("hex")}\n`, 0o600);
    steps.push(done("bearer token", `generated at ${tokenPath}, mode 600, never printed`));
  }
  const existing = io.readFile(configPath);
  if (existing === null) {
    const host = await lanIp(io);
    const config = { listen: { host, port: 7801 }, maxConcurrent: 2, repoPath, ...(repoUrl ? { repoUrl } : {}) };
    io.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    steps.push(done("config.json", `bound to ${host}:7801 (never 0.0.0.0)`));
  } else if (repoUrl && configuredRepoUrl(io) === undefined) {
    io.writeFile(configPath, JSON.stringify({ ...JSON.parse(existing), repoUrl }, null, 2) + "\n");
    steps.push(done("config.json", `recorded repoUrl ${repoUrl}`));
  } else {
    steps.push(skipped("config.json", "already present"));
  }
  return steps;
}

/**
 * Only what is still owed. A checklist that lists steps already done teaches
 * the reader to skim it, which is how the one line that mattered gets missed.
 */
export function remainder(io: Io, steps: Step[]): string[] {
  const owed: string[] = [];
  if (!io.exists(join(io.home, ".claude"))) owed.push("claude                       # then /login (browser)");
  if (!io.exists(join(io.home, ".codex", "auth.json"))) owed.push("codex login                  # (browser)");
  if (!(io.readFile(join(io.home, ".codex", "config.toml")) ?? "").includes("default_tools_approval_mode")) {
    owed.push(`${CODEX_MCP_ADD}\n     # the add command hangs after writing; the config still lands.\n     # Then rerun \`kairoku setup --daemon\` to pre-approve MCP writes.`);
  }
  for (const s of steps) if (s.outcome === "manual") owed.push(`${s.name}: ${s.detail}`);
  return owed;
}
