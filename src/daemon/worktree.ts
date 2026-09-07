/**
 * Worktree lifecycle (SPEC §Worktree module).
 *
 * Create: `git fetch origin`, then `git worktree add -b run/<runId> <dir> <base>`
 * against the configured base checkout, then the install this repo's own
 * lockfile names — none at all for a repo with no `package.json` — and a copy
 * of the base checkout's `.env*` files.
 *
 * Teardown removes the worktree but KEEPS the `run/<runId>` branch: the run's
 * commits are the deliverable, and the v0 exit criterion requires each run's
 * branch to remain checkable from its ledger entry alone.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

/**
 * A linked worktree's `.git` is a FILE pointing at
 * `<repo>/.git/worktrees/<name>`, and git reads `info/exclude` from the COMMON
 * dir — verified, not assumed: an exclude written under the per-worktree gitdir
 * is silently ignored. So this walks back to `<repo>/.git`, which is shared with
 * the base checkout.
 */
function gitCommonDir(worktree: string): string | undefined {
  const dotGit = join(worktree, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").trim();
    const target = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : "";
    if (!target) return undefined;
    // <repo>/.git/worktrees/<name> → <repo>/.git
    return resolve(dirname(resolve(worktree, target)), "..");
  } catch {
    return undefined;
  }
}

/**
 * Keep the daemon's own per-run plumbing out of the agent's diff.
 *
 * TWO CALLERS, ONE HELPER, and the second is why it lives here rather than
 * inside `providers/codex.ts` where it started: `.codex/` and `.codegraph/` are
 * the same defect one `git add -A` away, and a second copy of this walk is
 * exactly the drift `constraints.test.ts` exists to refuse. Idempotent, and it
 * never throws — a worktree whose exclude cannot be written is a run that fails
 * on the agent's own error, not on this.
 */
export function excludeFromGit(worktree: string, lines: readonly string[]): void {
  try {
    const common = gitCommonDir(worktree);
    if (!common) return;
    const path = join(common, "info", "exclude");
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      mkdirSync(dirname(path), { recursive: true });
    }
    const have = new Set(current.split("\n").map((line) => line.trim()));
    const missing = lines.filter((line) => !have.has(line));
    if (missing.length === 0) return;
    appendFileSync(path, `${current.endsWith("\n") || current === "" ? "" : "\n"}${missing.join("\n")}\n`);
  } catch {
    // Unwritable, or a checkout shape we do not know. The run still runs.
  }
}

/**
 * `env` REPLACES the daemon's own environment when it is given, rather than
 * being layered on top of it (O-4). A run's environment is the merge §20.11
 * defines and nothing else: inheriting `process.env` here would put the
 * daemon's own `DATABASE_URL` under a profile that did not name one, which is
 * the machine's database and not the run's.
 */
export async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  let proc;
  try {
    proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }) });
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

/**
 * R12 / DECISIONS §79.6(4) — the install a fresh worktree needs, chosen by the
 * lockfile that is on disk the moment git finishes.
 *
 * NOT from `kairoku.json`: `create()` runs before the run has a manifest in
 * hand, so a manifest-driven install would need an ordering this daemon does
 * not have. The lockfile is already there, which makes the choice
 * order-independent.
 *
 * NO `package.json` MEANS NO INSTALL. kairokud is a Rust workspace with none,
 * and `bun install` there exits 1 with "Bun could not find a package.json file
 * to install from" — which `must` turns into `worktree-setup-failed` before any
 * role runs. That is the defect this exists for.
 *
 * `corepack pnpm` rather than a bare `pnpm`: it is what kairoku-desktop's own
 * CI runs, and corepack ships with Node, so it needs nothing installed on the
 * box beyond the Node this daemon already assumes.
 *
 * Only the two package managers this workspace's repos actually use are here.
 * A yarn or npm branch would be a claim nothing exercises; add one the day a
 * repo arrives with that lockfile.
 */
async function installDependencies(path: string): Promise<void> {
  if (!existsSync(join(path, "package.json"))) return;
  if (existsSync(join(path, "pnpm-lock.yaml"))) {
    // Resolve `corepack` to an absolute path first — the daemon's own rule-3
    // idiom (dispatch.ts:243, :260). `Bun.spawn` on a bare name resolves against
    // the PATH captured at process start, so a PATH shadow (a test, or a service
    // manager's PATH) would not reach a different corepack; the resolved path
    // keeps `which` and `spawn` answering from the same PATH.
    const corepack = Bun.which("corepack", { PATH: process.env.PATH ?? "" });
    if (!corepack) {
      throw new Error(
        "corepack not found on PATH — a pnpm-lock.yaml repo needs it to install",
      );
    }
    await must([corepack, "pnpm", "install", "--frozen-lockfile"], path);
    return;
  }
  await must(["bun", "install"], path);
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
      await installDependencies(path);
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
