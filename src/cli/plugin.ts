/**
 * `kairoku plugin install|update|status` — the Claude Code plugin, through the
 * claude CLI's non-interactive plugin commands. Idempotent: an existing
 * marketplace registration (whatever its source) and an existing install are
 * left alone, so a rerun never re-points a live machine's registration.
 */

import type { Io } from "./io";

export const MARKETPLACE_SOURCE = "owds-inc/kairoku";
export const MARKETPLACE = "kairoku-marketplace";
/** The plugin's own name — also the directory `claude plugin install` creates. */
export const PLUGIN_NAME = "kairoku";
export const PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE}`;

export const usage = `usage: kairoku plugin install|update|status

  install   claude plugin marketplace add ${MARKETPLACE_SOURCE}
            claude plugin install ${PLUGIN} --scope user
  update    claude plugin marketplace update ${MARKETPLACE}
            claude plugin update ${PLUGIN} -y
  status    is ${PLUGIN} installed and enabled?`;

export const CLAUDE_MISSING = `claude (the Claude Code CLI) is not on PATH. Install it with one of:
  npm install -g @anthropic-ai/claude-code
  curl -fsSL https://claude.ai/install.sh | bash
then rerun this command.`;

async function json<T>(io: Io, argv: string[]): Promise<T | null> {
  const r = await io.shell(argv);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

export type InstalledPlugin = {
  id: string;
  version?: string;
  enabled?: boolean;
  scope?: string;
  /** Where claude unpacked it — `~/.claude/plugins/cache/<marketplace>/<name>/<version>`. */
  installPath?: string;
};

/**
 * The kairoku entry in `claude plugin list --json`. THE ONE PARSER of that
 * output: `doctor`, `setup` and the daemon's own `resolvePluginPath` all read
 * the installed plugin through this, so none of them can learn a different
 * answer to "is it installed, and where".
 */
export function pickPlugin(stdout: string): InstalledPlugin | null {
  try {
    return (JSON.parse(stdout) as InstalledPlugin[]).find((p) => p.id === PLUGIN) ?? null;
  } catch {
    return null;
  }
}

export async function installedPlugin(io: Io): Promise<InstalledPlugin | null> {
  const r = await io.shell(["claude", "plugin", "list", "--json"]);
  return r.code === 0 ? pickPlugin(r.stdout) : null;
}

export async function install(io: Io): Promise<number> {
  const markets = await json<Array<{ name: string }>>(io, ["claude", "plugin", "marketplace", "list", "--json"]);
  if (markets?.some((m) => m.name === MARKETPLACE)) {
    io.out(`marketplace ${MARKETPLACE} already registered`);
  } else {
    const r = await io.shell(["claude", "plugin", "marketplace", "add", MARKETPLACE_SOURCE], { live: true });
    if (r.code !== 0) return r.code;
  }
  const have = await installedPlugin(io);
  if (have) {
    io.out(`${PLUGIN} ${have.version ?? ""} already installed — \`kairoku plugin update\` updates it`);
    return 0;
  }
  const r = await io.shell(["claude", "plugin", "install", PLUGIN, "--scope", "user"], { live: true });
  if (r.code === 0) io.out(`${PLUGIN} installed — restart Claude Code sessions to load it`);
  return r.code;
}

export async function update(io: Io): Promise<number> {
  const m = await io.shell(["claude", "plugin", "marketplace", "update", MARKETPLACE], { live: true });
  if (m.code !== 0) return m.code;
  return (await io.shell(["claude", "plugin", "update", PLUGIN, "-y"], { live: true })).code;
}

export async function status(io: Io): Promise<number> {
  const have = await installedPlugin(io);
  if (!have) {
    io.out(`${PLUGIN} is not installed — run \`kairoku plugin install\``);
    return 1;
  }
  const state = have.enabled === false ? "disabled" : "enabled";
  io.out(`${PLUGIN} ${have.version ?? "?"} ${state} (scope ${have.scope ?? "user"})`);
  return 0;
}

const verbs: Record<string, (io: Io) => Promise<number>> = { install, update, status };

export async function run(args: string[], io: Io): Promise<number> {
  const verb = verbs[args[0] ?? ""];
  if (!verb) {
    io.err(usage);
    return 2;
  }
  if (!io.which("claude")) {
    io.err(CLAUDE_MISSING);
    return 1;
  }
  return verb(io);
}
