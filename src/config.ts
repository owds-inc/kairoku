/**
 * Config — `~/.hikyaku/config.json` plus `HIKYAKU_TOKEN` from the environment.
 *
 * The token deliberately never lives in the file (SPEC §Config): systemd's unit
 * environment holds it. The two optional function fields at the bottom are test
 * seams; `loadConfig` never populates them from JSON.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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

export function hikyakuHome(): string {
  return join(homedir(), ".hikyaku");
}

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
): string {
  return env.HIKYAKU_CONFIG ?? join(hikyakuHome(), "config.json");
}

export function loadConfig(
  path = defaultConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Config {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }

  const token = env.HIKYAKU_TOKEN ?? "";
  if (!token) throw new Error("HIKYAKU_TOKEN is required (RF-006)");

  const listen = (file.listen ?? {}) as Partial<Listen>;
  const host = listen.host ?? "127.0.0.1";
  assertBindable(host);

  const home = hikyakuHome();
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
