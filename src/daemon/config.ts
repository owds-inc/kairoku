/**
 * Config — `~/.kairoku/config.json`, plus the credentials from the environment
 * or `token.env` beside the config file.
 *
 * `KAIROKU_DAEMON_TOKEN` KEEPS ITS NAME AND CHANGES MEANING (SPEC v1, RF-011):
 * with the push API retired it is no longer an inbound bearer this daemon
 * checks, it is the credential this daemon presents to the Kairoku app — the
 * one Settings → Daemons prints. Nothing converts: an old value is simply not
 * a token the app knows, and `doctor` says so.
 *
 * No credential ever lives in config.json. `token.env` (mode 600, written by
 * `kairoku setup --daemon`) is how the service gets it, so neither the systemd
 * unit nor the launchd plist carries a secret. The pre-rename names —
 * HIKYAKU_CONFIG, HIKYAKU_TOKEN, `~/.hikyaku/` — are honoured for one version
 * with a deprecation line; `migrateHome` copies the old dir once.
 *
 * The token is OPTIONAL. A rejected token stops the loop but keeps the
 * listener up (RF-012), so an absent one cannot be a startup error either:
 * `doctor` has to be able to reach a daemon in exactly that state.
 *
 * The two optional function fields at the bottom are test seams; `loadConfig`
 * never populates them from JSON.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WorktreeOps } from "./worktree";
import { DEFAULT_PORT_RANGE, parsePortRange } from "./compose";
import { DEFAULT_KILL_GRACE_MS } from "./proc";

export interface Listen {
  readonly host: string;
  readonly port: number;
}

export interface Config {
  readonly listen: Listen;
  readonly maxConcurrent: number;
  /** Base checkout the worktrees are cut from. */
  readonly repoPath: string;
  readonly worktreesDir: string;
  readonly runsDir: string;
  readonly keepWorktreeOnFailure: boolean;
  readonly defaultTimeoutSec: number;
  /** Grace between SIGTERM and SIGKILL when killing an agent's process group. */
  readonly killGraceMs: number;

  /** RF-011 — the app this daemon links to, no trailing slash. Absent = unlinked. */
  readonly appUrl?: string;
  /** RF-011 — the credential presented to the app. Absent = unlinked. */
  readonly token?: string;
  /**
   * The interim `KAIROKU_PAT` for a run whose claim carried no run token.
   * O-2 mints one per run and this goes away (§20.7).
   */
  readonly agentToken?: string;
  /** The branch runs are cut from: `origin/<defaultBranch>`. */
  readonly defaultBranch: string;
  /**
   * O-4 (§20.11) — the range per-run service ports are allocated from, as
   * `"20000-29999"`. Every allocated port binds 127.0.0.1; which interface is
   * the repo's compose file's business, never this daemon's.
   */
  readonly ports: string;
  /**
   * O-3 — where the Kairoku plugin lives, when it is not where the daemon
   * would look. Absent is the ordinary case: `resolvePluginPath` finds the
   * source tree or the copy `kairoku plugin install` left under ~/.claude.
   */
  readonly pluginPath?: string;

  /** Test-only: substitute real git worktree operations. */
  readonly worktreeOps?: WorktreeOps;
}

export const DEFAULT_TIMEOUT_SEC = 3600;

export function kairokuHome(home = homedir()): string {
  return join(home, ".kairoku");
}

export type Warn = (line: string) => void;
const stderr: Warn = (line) => console.error(line);

/** Rejects wildcard binds — RF-006 requires an explicit host, never 0.0.0.0. */
export function assertBindable(host: string): void {
  if (host === "0.0.0.0" || host === "::" || host === "") {
    throw new Error(
      `refusing to bind to "${host}": RF-006 requires an explicit host address`,
    );
  }
}

export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
  warn: Warn = stderr,
): string {
  if (env.KAIROKU_DAEMON_CONFIG) return env.KAIROKU_DAEMON_CONFIG;
  if (env.HIKYAKU_CONFIG) {
    warn("HIKYAKU_CONFIG is deprecated — set KAIROKU_DAEMON_CONFIG instead");
    return env.HIKYAKU_CONFIG;
  }
  return join(kairokuHome(), "config.json");
}

/**
 * Every `KEY=value` line of a token.env. It carries two names now — the app
 * credential and the interim agent PAT — so a single-line regex would have to
 * grow one branch per name.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

/** The app credential in a token.env: `KAIROKU_DAEMON_TOKEN=…` (or the pre-rename name). */
export function parseTokenEnv(text: string): string | undefined {
  const env = parseEnvFile(text);
  return env.KAIROKU_DAEMON_TOKEN || env.HIKYAKU_TOKEN || undefined;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function readTokenEnv(path: string): string | undefined {
  const env = readEnvFile(path);
  return env.KAIROKU_DAEMON_TOKEN || env.HIKYAKU_TOKEN || undefined;
}

function resolveToken(
  fromFile: Record<string, string>,
  env: Record<string, string | undefined>,
  warn: Warn,
): string | undefined {
  if (env.KAIROKU_DAEMON_TOKEN) return env.KAIROKU_DAEMON_TOKEN;
  if (env.HIKYAKU_TOKEN) {
    warn("HIKYAKU_TOKEN is deprecated — set KAIROKU_DAEMON_TOKEN instead");
    return env.HIKYAKU_TOKEN;
  }
  return fromFile.KAIROKU_DAEMON_TOKEN || fromFile.HIKYAKU_TOKEN || undefined;
}

/** One trailing slash dropped here so no caller has to think about it again. */
export function normaliseAppUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * One-time move from the pre-rename `~/.hikyaku/`: config.json, token.env (its
 * line renamed, mode 600 kept) and the runs/ logs are copied — never moved, so
 * a daemon still running from the old dir keeps working until it is replaced.
 * worktrees/ stays: those paths belong to git, and `prune` enumerates them from
 * the repo, not from the dir.
 */
export function migrateHome(home = homedir()): "migrated" | "already" | "none" {
  const fresh = kairokuHome(home);
  const old = join(home, ".hikyaku");
  if (existsSync(fresh)) return "already";
  if (!existsSync(old)) return "none";
  mkdirSync(fresh, { recursive: true });
  for (const name of ["config.json", "runs"]) {
    if (existsSync(join(old, name))) cpSync(join(old, name), join(fresh, name), { recursive: true });
  }
  if (existsSync(join(old, "token.env"))) {
    const text = readFileSync(join(old, "token.env"), "utf8").replace(/^HIKYAKU_TOKEN=/m, "KAIROKU_DAEMON_TOKEN=");
    writeFileSync(join(fresh, "token.env"), text, { mode: 0o600 });
    chmodSync(join(fresh, "token.env"), 0o600);
  }
  return "migrated";
}

/**
 * A range nobody can parse falls back to the default with one warning, rather
 * than refusing to start: it matters only to repos with a compose profile, and
 * taking a whole machine offline over a typo in a field most repos never use is
 * the wrong trade. A run that then cannot get a port fails with its own reason.
 */
function readPortRange(value: unknown, warn: Warn): string {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_PORT_RANGE;
  if (parsePortRange(value)) return value;
  warn(`config.json: "ports": ${JSON.stringify(value)} is not a range like "${DEFAULT_PORT_RANGE}" — using the default`);
  return DEFAULT_PORT_RANGE;
}

export function loadConfig(
  path = defaultConfigPath(),
  env: Record<string, string | undefined> = process.env,
  warn: Warn = stderr,
): Config {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }

  const tokenEnv = readEnvFile(join(dirname(path), "token.env"));
  const token = resolveToken(tokenEnv, env, warn);
  const agentToken = env.KAIROKU_AGENT_TOKEN || tokenEnv.KAIROKU_AGENT_TOKEN || undefined;
  const appUrl = typeof file.appUrl === "string" && file.appUrl.trim() ? normaliseAppUrl(file.appUrl) : undefined;

  const listen = (file.listen ?? {}) as Partial<Listen>;
  const host = listen.host ?? "127.0.0.1";
  assertBindable(host);

  const home = kairokuHome();
  return {
    listen: { host, port: listen.port ?? 7801 },
    maxConcurrent: (file.maxConcurrent as number) ?? 2,
    repoPath: (file.repoPath as string) ?? join(homedir(), "work", "kairoku"),
    worktreesDir: (file.worktreesDir as string) ?? join(home, "worktrees"),
    runsDir: (file.runsDir as string) ?? join(home, "runs"),
    keepWorktreeOnFailure: (file.keepWorktreeOnFailure as boolean) ?? false,
    defaultTimeoutSec: (file.defaultTimeoutSec as number) ?? DEFAULT_TIMEOUT_SEC,
    killGraceMs: (file.killGraceMs as number) ?? DEFAULT_KILL_GRACE_MS,
    defaultBranch: (file.defaultBranch as string) ?? "main",
    ports: readPortRange(file.ports, warn),
    ...(typeof file.pluginPath === "string" && file.pluginPath ? { pluginPath: file.pluginPath } : {}),
    ...(appUrl === undefined ? {} : { appUrl }),
    ...(token === undefined ? {} : { token }),
    ...(agentToken === undefined ? {} : { agentToken }),
  };
}
