/**
 * Config — `~/.kairoku/config.json`, plus the bearer token from
 * KAIROKU_DAEMON_TOKEN or `token.env` beside the config file.
 *
 * The token never lives in config.json (SPEC §Config). `token.env` (mode 600,
 * written by `kairoku setup --daemon`) is how the service gets it, so neither
 * the systemd unit nor the launchd plist carries a secret. The pre-rename
 * names — HIKYAKU_CONFIG, HIKYAKU_TOKEN, `~/.hikyaku/` — are honoured for one
 * version with a deprecation line; `migrateHome` copies the old dir once.
 * The two optional function fields at the bottom are test seams; `loadConfig`
 * never populates them from JSON.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandSpec } from "./roles";
import type { WorktreeOps } from "./worktree";
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
  readonly token: string;

  /** Test-only (RF-009): substitute the role's command construction. */
  readonly commandOverride?: (spec: CommandSpec) => string[];
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

/** The token line of a token.env file: `KAIROKU_DAEMON_TOKEN=…` (or the pre-rename name). */
export function readTokenEnv(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").match(/^(?:KAIROKU_DAEMON_TOKEN|HIKYAKU_TOKEN)=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function resolveToken(configPath: string, env: Record<string, string | undefined>, warn: Warn): string {
  if (env.KAIROKU_DAEMON_TOKEN) return env.KAIROKU_DAEMON_TOKEN;
  if (env.HIKYAKU_TOKEN) {
    warn("HIKYAKU_TOKEN is deprecated — set KAIROKU_DAEMON_TOKEN instead");
    return env.HIKYAKU_TOKEN;
  }
  const tokenPath = join(dirname(configPath), "token.env");
  const fromFile = readTokenEnv(tokenPath);
  if (fromFile) return fromFile;
  throw new Error(`KAIROKU_DAEMON_TOKEN is required (RF-006): set it, or write it to ${tokenPath}`);
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

  const token = resolveToken(path, env, warn);

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
    token,
  };
}
