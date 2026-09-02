/**
 * Real git, no network: a bare repo on disk stands in for `origin`. These
 * exercise the actual `git worktree add` / `remove` path the daemon uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchFor,
  copyEnvFiles,
  gitWorktreeOps,
  listRunWorktrees,
  originFullName,
  parseRepoFullName,
  run,
  DEFAULT_BASE,
  RUN_BRANCH_PREFIX,
} from "./worktree";

let root: string;
let repoPath: string;
let worktreesDir: string;

async function git(args: string[], cwd: string) {
  const result = await run(
    ["git", "-c", "user.email=t@example.com", "-c", "user.name=Test", ...args],
    cwd,
  );
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kairoku-wt-"));
  const origin = join(root, "origin.git");
  repoPath = join(root, "base");
  worktreesDir = join(root, "worktrees");
  mkdirSync(worktreesDir, { recursive: true });

  await git(["init", "--bare", "--initial-branch=main", origin], root);
  await git(["clone", origin, repoPath], root);
  writeFileSync(join(repoPath, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(repoPath, "README.md"), "fixture\n");
  writeFileSync(join(repoPath, ".env.local"), "SECRET=from-base\n");
  writeFileSync(join(repoPath, ".env.test"), "MODE=test\n");
  // .env* is gitignored in the real checkout too — copying is why it works.
  writeFileSync(join(repoPath, ".gitignore"), ".env*\nnode_modules/\n");
  await git(["add", "-A"], repoPath);
  await git(["commit", "-m", "fixture"], repoPath);
  await git(["push", "origin", "main"], repoPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("worktree", () => {
  test("branch names carry the run/ prefix prune keys off", () => {
    expect(branchFor("abc123")).toBe("run/abc123");
    expect(branchFor("abc123").startsWith(RUN_BRANCH_PREFIX)).toBe(true);
    expect(DEFAULT_BASE).toBe("origin/main");
  });

  test("concurrent creates against one base checkout all succeed, and so do concurrent removes", async () => {
    // Two `git worktree add`s in the same checkout race on .git/config (the new
    // branch's upstream is written there): the loser fails with "could not lock
    // config file". The daemon serialises worktree creation and removal.
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const ids = ["c1", "c2", "c3", "c4"];
    const made = await Promise.all(ids.map((id) => ops.create(id)));
    for (const [i, wt] of made.entries()) {
      expect(wt.branch).toBe(`run/${ids[i]}`);
      expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    }
    const { stdout } = await git(["branch", "--list", "run/*"], repoPath);
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(4);
    await Promise.all(made.map((wt) => ops.remove(wt)));
    expect(await listRunWorktrees(repoPath)).toEqual([]);
  }, 30_000);

  test("create cuts a run/<id> worktree from origin/main and seeds it", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const worktree = await ops.create("run1");

    expect(worktree.path).toBe(join(worktreesDir, "run1"));
    expect(worktree.branch).toBe("run/run1");
    expect(existsSync(join(worktree.path, "README.md"))).toBe(true);

    // .env* copied from the base checkout, not from git.
    expect(await Bun.file(join(worktree.path, ".env.local")).text()).toBe(
      "SECRET=from-base\n",
    );
    expect(existsSync(join(worktree.path, ".env.test"))).toBe(true);

    const { stdout } = await git(["branch", "--list", "run/run1"], repoPath);
    expect(stdout).toContain("run/run1");
  });

  test("a second run gets its own worktree and branch", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    await ops.create("runA");
    await ops.create("runB");
    const listed = await listRunWorktrees(repoPath);
    expect(listed.map((w) => w.branch).sort()).toEqual(["run/runA", "run/runB"]);
  });

  test("create refuses a run id whose branch already exists", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    await ops.create("dupe");
    await expect(ops.create("dupe")).rejects.toThrow(/git worktree add/);
  });

  test("remove deletes the worktree but KEEPS the branch and its commits", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const worktree = await ops.create("keeper");

    writeFileSync(join(worktree.path, "work.txt"), "the agent's output\n");
    await git(["add", "-A"], worktree.path);
    await git(["commit", "-m", "agent work"], worktree.path);

    await ops.remove(worktree);
    expect(existsSync(worktree.path)).toBe(false);

    // The deliverable survives teardown — the exit criterion depends on it.
    const { stdout } = await git(
      ["log", "--oneline", "-1", "run/keeper"],
      repoPath,
    );
    expect(stdout).toContain("agent work");
    expect(await listRunWorktrees(repoPath)).toHaveLength(0);
  });

  test("remove forces past the uncommitted files agents routinely leave", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const worktree = await ops.create("dirty");
    writeFileSync(join(worktree.path, "scratch.txt"), "uncommitted\n");
    writeFileSync(join(worktree.path, "README.md"), "modified\n");
    await ops.remove(worktree);
    expect(existsSync(worktree.path)).toBe(false);
  });

  test("listRunWorktrees ignores worktrees that are not runs", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    await ops.create("real");
    await git(
      ["worktree", "add", "-b", "feature/x", join(root, "manual"), "origin/main"],
      repoPath,
    );
    const listed = await listRunWorktrees(repoPath);
    expect(listed.map((w) => w.branch)).toEqual(["run/real"]);
  });

  test("copyEnvFiles copies only .env*, and tolerates a missing base checkout", async () => {
    const dest = join(root, "dest");
    mkdirSync(dest, { recursive: true });
    expect(await copyEnvFiles(repoPath, dest)).toBe(2);
    expect(existsSync(join(dest, ".env.local"))).toBe(true);
    expect(existsSync(join(dest, "README.md"))).toBe(false);
    expect(await copyEnvFiles(join(root, "absent"), dest)).toBe(0);
  });

  test("a failing git command surfaces its stderr, not a bare exit code", async () => {
    const notARepo = join(root, "plain-dir");
    mkdirSync(notARepo, { recursive: true });
    const ops = gitWorktreeOps(notARepo, worktreesDir);
    await expect(ops.create("x")).rejects.toThrow(
      /git fetch origin failed \(exit \d+\).*repository/is,
    );
  });

  test("a missing base checkout names the directory, not the git binary", async () => {
    // Bun reports a missing cwd as ENOENT against the binary, which reads as
    // "git is not installed" and sends the reader down the wrong path.
    const ops = gitWorktreeOps(join(root, "absent-checkout"), worktreesDir);
    await expect(ops.create("x")).rejects.toThrow(
      /git could not be started in .*absent-checkout/,
    );
  });
});

describe("§20.9 — the checkout's own owner/name", () => {
  test("both remote URL forms parse, .git goes, and a nested group keeps its path", () => {
    for (const url of [
      "https://github.com/owds-inc/kairoku.git",
      "https://github.com/owds-inc/kairoku",
      "git@github.com:owds-inc/kairoku.git",
      "ssh://git@github.com/owds-inc/kairoku.git",
      "  https://user@github.com/owds-inc/kairoku.git\n",
    ]) {
      expect({ [url]: parseRepoFullName(url) }).toEqual({ [url]: "owds-inc/kairoku" });
    }
    expect(parseRepoFullName("https://gitlab.com/group/sub/thing.git")).toBe("group/sub/thing");
    // Nothing that is not a two-segment path is guessed at.
    for (const junk of ["", "kairoku", "https://github.com/lonely", "not a url"]) {
      expect({ [junk]: parseRepoFullName(junk) }).toEqual({ [junk]: undefined });
    }
  });

  test("a real checkout answers with its origin; a directory that is not one answers undefined", async () => {
    const checkout = join(root, "named-checkout");
    mkdirSync(checkout, { recursive: true });
    await run(["git", "init", "-q"], checkout);
    await run(["git", "remote", "add", "origin", "https://example.invalid/owds-inc/kairoku.git"], checkout);
    expect(await originFullName(checkout)).toBe("owds-inc/kairoku");

    const plain = join(root, "plain-checkout");
    mkdirSync(plain, { recursive: true });
    expect(await originFullName(plain)).toBeUndefined();
    expect(await originFullName(join(root, "absent"))).toBeUndefined();
  });
});
