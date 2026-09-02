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
  // `git worktree add` writes the new branch's upstream into .git/config and
  // `remove` rewrites .git/worktrees/; two at once collide with "could not
  // lock config file .git/config: File exists" and the loser's run dies before
  // it starts. One queue per base checkout serialises the git steps — the
  // agents themselves still run concurrently, and `bun install` stays outside
  // the queue because it never touches .git.
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  return {
    async create(runId, base = DEFAULT_BASE): Promise<Worktree> {
      const path = join(worktreesDir, runId);
      const branch = branchFor(runId);
      await serialised(async () => {
        await must(["git", "fetch", "origin"], repoPath);
        await must(
          ["git", "worktree", "add", "-b", branch, path, base],
          repoPath,
        );
      });
      await must(["bun", "install"], path);
      await copyEnvFiles(repoPath, path);
      return { path, branch };
    },

    remove(worktree): Promise<void> {
      // --force: the agent leaves uncommitted files behind routinely.
      return serialised(async () => {
        await must(["git", "worktree", "remove", "--force", worktree.path], repoPath);
      });
    },
  };
}

/**
 * §20.9 — `owner/name` out of an origin remote URL. Both forms git writes are
 * accepted (scheme URL and the scp-like one), the `.git` suffix is dropped, and
 * a nested GitLab group keeps its whole path because that IS the name.
 */
export function parseRepoFullName(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const path =
    url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)?.[1] ?? url.match(/^[^/]+@[^:/]+:(.+)$/)?.[1];
  const segments = path?.split("/").filter(Boolean) ?? [];
  return segments.length >= 2 ? segments.join("/") : undefined;
}

/**
 * The `owner/name` of the configured checkout, asked of git once at boot.
 * `undefined` means "this daemon cannot say what it has a checkout of" — the
 * §20.9 guard treats that as a mismatch, so a wrong repo is never run.
 */
export async function originFullName(repoPath: string): Promise<string | undefined> {
  try {
    const result = await run(["git", "remote", "get-url", "origin"], repoPath);
    return result.code === 0 ? parseRepoFullName(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

export interface StaleWorktree {
  readonly path: string;
  readonly branch: string;
}

/**
 * Enumerate run worktrees for the `kairoku daemon prune` CLI — `git worktree list`
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
