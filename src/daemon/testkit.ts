/**
 * Test support: a temp-dir Config, a fake WorktreeOps, and stub agent commands.
 *
 * No test in this repo touches the network, a real `codex`, or a real Kairoku.
 * The role table is never given a test-mode entry (RF-009) — stub commands
 * arrive through `Config.commandOverride`, which production config cannot set.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import type { Worktree, WorktreeOps } from "./worktree";
import { branchFor } from "./worktree";

export interface FakeWorktrees extends WorktreeOps {
  readonly created: Worktree[];
  readonly removed: Worktree[];
  /** Make the next create() reject, to exercise the setup-failure path. */
  failNext: boolean;
  /** Delay create() so cancel/shutdown can land mid-setup. */
  delayMs: number;
}

export function fakeWorktrees(root: string): FakeWorktrees {
  const ops: FakeWorktrees = {
    created: [],
    removed: [],
    failNext: false,
    delayMs: 0,
    async create(runId) {
      if (ops.delayMs) await Bun.sleep(ops.delayMs);
      if (ops.failNext) {
        ops.failNext = false;
        throw new Error("fetch refused");
      }
      const path = join(root, runId);
      mkdirSync(path, { recursive: true });
      const worktree = { path, branch: branchFor(runId) };
      ops.created.push(worktree);
      return worktree;
    },
    async remove(worktree) {
      ops.removed.push(worktree);
      rmSync(worktree.path, { recursive: true, force: true });
    },
  };
  return ops;
}

export interface Harness {
  readonly config: Config;
  readonly dir: string;
  readonly worktrees: FakeWorktrees;
  cleanup(): void;
}

export const TEST_TOKEN = "test-bearer-token";

export function harness(overrides: Partial<Config> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-test-"));
  const worktreesDir = join(dir, "worktrees");
  const runsDir = join(dir, "runs");
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const worktrees = fakeWorktrees(worktreesDir);

  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    maxConcurrent: 2,
    repoPath: join(dir, "repo"),
    worktreesDir,
    runsDir,
    keepWorktreeOnFailure: false,
    defaultTimeoutSec: 30,
    killGraceMs: 150,
    token: TEST_TOKEN,
    worktreeOps: worktrees,
    // Default stub agent: exits 0 immediately, reading its brief from stdin.
    commandOverride: () => ["sh", "-c", "cat > brief.txt"],
    ...overrides,
  };

  return {
    config,
    dir,
    worktrees,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A valid POST /runs body; `pat` distinguishes credential identities. */
export function runRequest(pat: string, extra: Record<string, unknown> = {}) {
  return {
    role: "executor",
    brief: "build the thing",
    env: { KAIROKU_PAT: pat },
    ...extra,
  };
}

/** Poll until `predicate` holds, or fail loudly rather than hang the suite. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for: ${message}`);
}

export function pathGone(path: string): boolean {
  return !existsSync(path);
}
