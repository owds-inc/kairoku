/**
 * Worktree lifecycle (SPEC §Worktree module).
 *
 * Create: `git fetch origin`, then `git worktree add -b run/<runId> <dir> <base>`
 * against the configured base checkout, then `bun install` and a copy of the
 * base checkout's `.env*` files.
 *
 * Teardown removes the worktree but KEEPS the `run/<runId>` branch: the run's
 * commits are the deliverable, and the v0 exit criterion requires each run's
 * branch to remain checkable from its ledger entry alone.
 */

import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Worktree {
  readonly path: string;
  readonly branch: string;
}

export interface WorktreeOps {
  create(runId: string, base?: string): Promise<Worktree>;
  remove(worktree: Worktree): Promise<void>;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const RUN_BRANCH_PREFIX = "run/";
export const DEFAULT_BASE = "origin/main";

export function branchFor(runId: string): string {
  return `${RUN_BRANCH_PREFIX}${runId}`;
}

export async function run(
  command: string[],
  cwd: string,
): Promise<CommandResult> {
  let proc;
  try {
    proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    // A missing cwd surfaces from Bun as ENOENT against the *binary*, which
    // reads as "git is not installed". Name the directory instead.
    throw new Error(
      `${command[0]} could not be started in ${cwd}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function must(command: string[], cwd: string): Promise<CommandResult> {
  const result = await run(command, cwd);
  if (result.code !== 0) {
    throw new Error(
      `${command.join(" ")} failed (exit ${result.code}): ${
        (result.stderr || result.stdout).trim().slice(0, 500)
      }`,
    );
  }
  return result;
}

/** Copy the base checkout's `.env*` files into a fresh worktree. */
export async function copyEnvFiles(
  repoPath: string,
  worktreePath: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(repoPath);
  } catch {
    return 0;
  }
  const envFiles = entries.filter((name) => name.startsWith(".env"));
  await Promise.all(
    envFiles.map((name) =>
      copyFile(join(repoPath, name), join(worktreePath, name)),
    ),
  );
  return envFiles.length;
}

export function gitWorktreeOps(
  repoPath: string,
  worktreesDir: string,
): WorktreeOps {
  return {
    async create(runId, base = DEFAULT_BASE): Promise<Worktree> {
      const path = join(worktreesDir, runId);
      const branch = branchFor(runId);
      await must(["git", "fetch", "origin"], repoPath);
      await must(
        ["git", "worktree", "add", "-b", branch, path, base],
        repoPath,
      );
      await must(["bun", "install"], path);
      await copyEnvFiles(repoPath, path);
      return { path, branch };
    },

    async remove(worktree): Promise<void> {
      // --force: the agent leaves uncommitted files behind routinely.
      await must(["git", "worktree", "remove", "--force", worktree.path], repoPath);
    },
  };
}

export interface StaleWorktree {
  readonly path: string;
  readonly branch: string;
}

/**
 * Enumerate run worktrees for the `hikyaku prune` CLI — `git worktree list`
 * filtered by the `run/` branch prefix. No breadcrumb store needed.
 */
export async function listRunWorktrees(
  repoPath: string,
): Promise<StaleWorktree[]> {
  const { stdout } = await must(
    ["git", "worktree", "list", "--porcelain"],
    repoPath,
  );
  const found: StaleWorktree[] = [];
  let path = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) {
      const branch = line.slice("branch refs/heads/".length);
      if (branch.startsWith(RUN_BRANCH_PREFIX) && path) {
        found.push({ path, branch });
      }
    }
  }
  return found;
}
