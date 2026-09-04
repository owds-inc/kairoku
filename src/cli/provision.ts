/**
 * The machine steps of `kairoku setup --daemon`, ported one for one from the
 * bash script (and, before it, orch/setup-agent-vm.sh in the planning repo).
 * Each step is idempotent and safe on a live machine: it installs only what
 * is missing, never upgrades a runtime out from under a running agent, and
 * hands back the exact commands when it cannot do a step itself.
 */

import { dirname, join } from "node:path";
import { DEFAULT_PORT_RANGE } from "../daemon/compose";
import { kairokuHome } from "../daemon/config";
import { AST_GREP } from "../daemon/rules";
import { version, type Io } from "./io";

export type Step = { name: string; outcome: "done" | "skipped" | "manual"; detail: string };
const done = (name: string, detail: string): Step => ({ name, outcome: "done", detail });
const skipped = (name: string, detail: string): Step => ({ name, outcome: "skipped", detail });
const manual = (name: string, detail: string): Step => ({ name, outcome: "manual", detail });

export const NODE_MAJOR = 24;

/** ast-grep ships a per-platform release binary through this npm wrapper. */
export const AST_GREP_PACKAGE = "@ast-grep/cli";
export { AST_GREP };

/** §21 item 6 — Claude Code's built-in LSP tool finds this on PATH. */
export const LSP_PACKAGES = ["typescript-language-server", "typescript"] as const;

/**
 * The app checkout the daemon cuts worktrees from. DECISIONS §18/§28: the app
 * lives on GitLab at https://gitlab.com/owds-inc/kairoku/kairoku — clones use
 * plain git over HTTPS, same as any other repo. The operator's choice is
 * persisted as `repoUrl` in config.json, so a rerun never asks again.
 */
export const DEFAULT_APP_REPO = "https://gitlab.com/owds-inc/kairoku/kairoku.git";

/**
 * Where Settings → Daemons lives for the hosted app. The snippet it prints is
 * `KAIROKU_URL=<origin>` + `KAIROKU_DAEMON_TOKEN=<kai_…>`, so this is only the
 * default the prompt offers — a self-hosted app types its own.
 */
export const DEFAULT_APP_URL = "https://kairoku.io";

/**
 * §21 item 5b — NO BEARER FLAG, and the human logs in with OAuth.
 *
 * The bearer form provisioned a machine-wide `bearer_token_env_var =
 * "KAIROKU_PAT"`. `KAIROKU_PAT` is only ever set INSIDE a run, and Codex prefers
 * the bearer path once the variable is configured, so the operator's own
 * interactive Codex on the same machine got `401 No authorization provided` and
 * its own OAuth login was ignored (found 2026-09-03 on Neil's Mac). The run's
 * credential now lives in the run's own `.codex/config.toml`, written per
 * dispatch by `providers/codex.ts`, and the machine keeps none of it.
 */
export const CODEX_MCP_ADD = "timeout 15 codex mcp add kairoku --url https://kairoku.io/api/mcp";
export const CODEX_MCP_LOGIN = "codex mcp login kairoku            # (browser)";

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

  // §21 Q25 — ast-grep is ONE BINARY, and a repo that declares
  // `.kairoku/rules/` fails its runs closed on a machine without it. Installed
  // the way every other CLI here is installed, and SKIPPED when present for the
  // same reason as the rest: this is provisioning, not an update channel.
  if (io.which(AST_GREP)) {
    steps.push(skipped(AST_GREP, `${await version(io, AST_GREP)} already installed`));
  } else {
    const install = await io.shell(["npm", "install", "-g", AST_GREP_PACKAGE], { live: true });
    steps.push(
      install.code === 0
        ? done(AST_GREP, `npm install -g ${AST_GREP_PACKAGE}`)
        : manual(AST_GREP, `npm install -g ${AST_GREP_PACKAGE} failed (exit ${install.code}) — a repo with .kairoku/rules cannot run here until it is present`),
    );
  }
  return steps;
}

/**
 * O-4 (§20.11) — Docker Compose is the one service engine, so a machine that
 * runs repos with an `env.<profile>.compose` needs it.
 *
 * Installed is SKIPPED, never upgraded: this is provisioning, not an update
 * channel, and swapping the container engine under a running agent is how a
 * whole machine's work is lost at once. Installed but not ANSWERING is a manual
 * step — `apt-get install` cannot fix a stopped daemon or a socket this user
 * has no group membership for.
 *
 * On mac it names the install rather than pretending: OrbStack and Docker
 * Desktop are both GUI installs with licence terms, and a setup script that
 * `brew install --cask`s one of them behind an operator's back is overreach.
 */
export async function docker(io: Io): Promise<Step> {
  const name = "docker (per-run services)";
  if (io.which("docker")) {
    const version = await io.shell(["docker", "compose", "version"]);
    return version.code === 0
      ? skipped(name, `${version.stdout.trim().split("\n")[0]} already installed`)
      : manual(
          name,
          "docker is installed but not answering — start it, and check this user is in the `docker` group:\n" +
            "     sudo systemctl enable --now docker && sudo usermod -aG docker $USER   # then log out and back in",
        );
  }

  const APT = "sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin";
  if (io.platform !== "linux") {
    return manual(
      name,
      "not installed — install OrbStack (https://orbstack.dev) or Docker Desktop, then rerun `kairoku setup --daemon`",
    );
  }
  if (!(await sudoOk(io))) {
    return manual(
      name,
      "no passwordless sudo — run by hand:\n" +
        `     ${APT}\n` +
        "     sudo usermod -aG docker $USER   # then log out and back in",
    );
  }
  const install = await io.shell(["bash", "-c", APT], { live: true });
  if (install.code !== 0) return manual(name, `${APT} failed (exit ${install.code})`);
  // Without the group the socket is root-only and every compose call fails with
  // "permission denied", which reads as a broken daemon rather than a missing
  // login. It only takes effect on a new session, so the step SAYS so.
  await io.shell(["bash", "-c", "sudo usermod -aG docker $USER"]);
  return done(name, "installed from apt and added this user to `docker` — log out and back in for the group to take effect");
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
 * §21 item 5b — the machine-wide kairoku MCP entry must carry NO bearer.
 *
 * This step used to ADD `default_tools_approval_mode = "approve"` beside a
 * machine-wide `bearer_token_env_var = "KAIROKU_PAT"`. Both now belong to the
 * RUN, written per dispatch into the worktree's own `.codex/config.toml`. What
 * is checked here is the opposite property: that the human's own Codex reaches
 * Kairoku through `codex mcp login` (OAuth) and is not silently pushed onto a
 * bearer path whose variable is never set outside a run.
 *
 * It REPORTS rather than rewrites. `~/.codex/config.toml` is the operator's own
 * file, and a provisioning step that edits a human's credentials out from under
 * them is worse than a line of output.
 */
export async function codexConfig(io: Io): Promise<Step> {
  const name = "codex MCP (human login)";
  const path = join(io.home, ".codex", "config.toml");
  const text = io.readFile(path);
  if (text === null) {
    return manual(
      name,
      `no ~/.codex/config.toml yet — run \`codex login\`, then:\n     ${CODEX_MCP_ADD}\n     ${CODEX_MCP_LOGIN}`,
    );
  }
  if (/bearer_token_env_var\s*=\s*"KAIROKU_PAT"/.test(text)) {
    return manual(
      name,
      "the kairoku MCP entry in ~/.codex/config.toml carries bearer_token_env_var — that variable is only set\n" +
        "     inside a run, so your own Codex gets 401 and ignores its OAuth login. Remove it and re-add:\n" +
        "     codex mcp remove kairoku\n" +
        `     ${CODEX_MCP_ADD}\n     ${CODEX_MCP_LOGIN}`,
    );
  }
  if (!text.includes("[mcp_servers.kairoku]")) {
    return manual(name, `kairoku MCP entry not found in ${path} — add it with:\n     ${CODEX_MCP_ADD}\n     ${CODEX_MCP_LOGIN}`);
  }
  return skipped(name, "OAuth entry, no bearer — a run brings its own credential");
}

/**
 * §21 item 6 — EXACT RESOLUTION. Claude Code's built-in LSP tool finds a
 * language server on PATH; a TypeScript repo therefore gets one, so an
 * implementer can resolve a symbol instead of grepping for its name.
 *
 * Through BUN, not npm: the daemon's own runtime, already provisioned, and the
 * one every machine here has. Absent is a WARN in `doctor` and never a FAIL, so
 * a failed install is a `manual` line rather than a stopped setup — the
 * degraded path (grep, and a Codex implementer) still works.
 */
export async function languageServer(io: Io, repoPath: string): Promise<Step> {
  const name = "typescript-language-server (exact resolution)";
  if (!io.exists(join(repoPath, "tsconfig.json"))) {
    return skipped(name, `no tsconfig.json in ${repoPath} — nothing here needs a TypeScript server`);
  }
  if (io.which(LSP_PACKAGES[0])) return skipped(name, `${await version(io, LSP_PACKAGES[0])} already installed`);
  const install = await io.shell(["bun", "add", "-g", ...LSP_PACKAGES], { live: true });
  return install.code === 0
    ? done(name, `bun add -g ${LSP_PACKAGES.join(" ")}`)
    : manual(name, `bun add -g ${LSP_PACKAGES.join(" ")} failed (exit ${install.code}) — runs still work, symbols are grepped`);
}

export function configuredRepoUrl(io: Io): string | undefined {
  try {
    const parsed = JSON.parse(io.readFile(join(kairokuHome(io.home), "config.json")) ?? "{}") as { repoUrl?: unknown };
    return typeof parsed.repoUrl === "string" ? parsed.repoUrl : undefined;
  } catch {
    return undefined;
  }
}

export const LOOPBACK = "127.0.0.1";
export { DEFAULT_PORT_RANGE };

/**
 * `~/.kairoku/config.json`.
 *
 * It mints NO credential. The bearer this used to generate belonged to the
 * push API, which is retired (SPEC v1, §20.3); the only credential a daemon
 * holds now is the app's, and that comes from Settings → Daemons through
 * `setup`'s app-link step.
 *
 * And the listener moves to loopback for the same reason: it answers `doctor`
 * and nothing else, unauthenticated. A config still bound to a LAN address
 * from the push-API days is pulled back — leaving it there would publish an
 * unauthenticated surface on the network.
 *
 * `pluginPath` is recorded here for the same reason the app link is proved
 * here: the daemon ships as a compiled binary with no checkout beside it, and
 * resolving the plugin at run time from a cold start is one more thing that can
 * be wrong on a machine nobody is watching. Absent when nothing resolved — a
 * guessed path would be worse than the fail-closed message.
 */
export interface DaemonConfigOptions {
  readonly repoUrl?: string;
  readonly pluginPath?: string;
  /** O-4 — the range per-run service ports are allocated from. */
  readonly ports?: string;
}

export async function daemonConfig(
  io: Io,
  repoPath: string,
  options: DaemonConfigOptions = {},
): Promise<Step[]> {
  const { repoUrl, pluginPath, ports } = options;
  const configPath = join(kairokuHome(io.home), "config.json");
  const existing = io.readFile(configPath);
  if (existing === null) {
    const config = {
      listen: { host: LOOPBACK, port: 7801 },
      maxConcurrent: 2,
      repoPath,
      ...(repoUrl ? { repoUrl } : {}),
      ...(pluginPath ? { pluginPath } : {}),
      ...(ports ? { ports } : {}),
    };
    io.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    return [done("config.json", `bound to ${LOOPBACK}:7801 (the listener answers doctor only)`)];
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return [manual("config.json", `${configPath} is not valid JSON — fix or delete it, then rerun`)];
  }

  const listen = (config.listen ?? {}) as { host?: string; port?: number };
  const changes: string[] = [];
  if (listen.host && listen.host !== LOOPBACK) {
    config.listen = { ...listen, host: LOOPBACK };
    changes.push(`rebound ${listen.host} → ${LOOPBACK} (the push API is retired)`);
  }
  if (repoUrl && config.repoUrl !== repoUrl) {
    config.repoUrl = repoUrl;
    changes.push(`recorded repoUrl ${repoUrl}`);
  }
  if (pluginPath && config.pluginPath !== pluginPath) {
    config.pluginPath = pluginPath;
    changes.push(`recorded pluginPath ${pluginPath}`);
  }
  if (ports && config.ports !== ports) {
    config.ports = ports;
    changes.push(`recorded per-run port range ${ports}`);
  }
  if (changes.length === 0) return [skipped("config.json", "already present")];
  io.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  return [done("config.json", changes.join("; "))];
}

/** Write the app URL and the credential. The token is written, never printed. */
export function writeAppLink(io: Io, appUrl: string, token: string): void {
  const dir = kairokuHome(io.home);
  io.writeFile(join(dir, "token.env"), `KAIROKU_DAEMON_TOKEN=${token}\n`, 0o600);
  const configPath = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(io.readFile(configPath) ?? "{}") as Record<string, unknown>;
  } catch {
    config = {};
  }
  io.writeFile(configPath, JSON.stringify({ ...config, appUrl }, null, 2) + "\n");
}

/**
 * Only what is still owed. A checklist that lists steps already done teaches
 * the reader to skim it, which is how the one line that mattered gets missed.
 */
export function remainder(io: Io, steps: Step[]): string[] {
  const owed: string[] = [];
  if (!io.exists(join(io.home, ".claude"))) owed.push("claude                       # then /login (browser)");
  if (!io.exists(join(io.home, ".codex", "auth.json"))) owed.push("codex login                  # (browser)");
  if (!(io.readFile(join(io.home, ".codex", "config.toml")) ?? "").includes("[mcp_servers.kairoku]")) {
    owed.push(`${CODEX_MCP_ADD}\n     # the add command hangs after writing; the config still lands.\n     ${CODEX_MCP_LOGIN}`);
  }
  for (const s of steps) if (s.outcome === "manual") owed.push(`${s.name}: ${s.detail}`);
  return owed;
}
