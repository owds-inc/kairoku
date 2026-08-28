/**
 * `hikyaku prune` is the ONLY path that removes a stale worktree — the daemon
 * never sweeps. These use a real git repo so the removal is real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPlan, main } from "./prune";
import { gitWorktreeOps, listRunWorktrees, run } from "./worktree";

let root: string;
let repoPath: string;
let worktreesDir: string;
let previousConfig: string | undefined;
let previousToken: string | undefined;
const logged: string[] = [];
let restoreLog: (() => void) | undefined;
let restorePrompt: (() => void) | undefined;

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
  root = mkdtempSync(join(tmpdir(), "hikyaku-prune-"));
  const origin = join(root, "origin.git");
  repoPath = join(root, "base");
  worktreesDir = join(root, "worktrees");
  mkdirSync(worktreesDir, { recursive: true });

  await git(["init", "--bare", "--initial-branch=main", origin], root);
  await git(["clone", origin, repoPath], root);
  writeFileSync(join(repoPath, "package.json"), '{"name":"fixture"}\n');
  await git(["add", "-A"], repoPath);
  await git(["commit", "-m", "fixture"], repoPath);
  await git(["push", "origin", "main"], repoPath);

  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ repoPath, worktreesDir, runsDir: join(root, "runs") }),
  );
  previousConfig = process.env.HIKYAKU_CONFIG;
  previousToken = process.env.HIKYAKU_TOKEN;
  process.env.HIKYAKU_CONFIG = configPath;
  process.env.HIKYAKU_TOKEN = "prune-test-token";

  logged.length = 0;
  const realLog = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  restoreLog = () => {
    console.log = realLog;
  };
});

afterEach(() => {
  restoreLog?.();
  restorePrompt?.();
  restoreLog = restorePrompt = undefined;
  if (previousConfig === undefined) delete process.env.HIKYAKU_CONFIG;
  else process.env.HIKYAKU_CONFIG = previousConfig;
  if (previousToken === undefined) delete process.env.HIKYAKU_TOKEN;
  else process.env.HIKYAKU_TOKEN = previousToken;
  rmSync(root, { recursive: true, force: true });
});

function stubPrompt(answer: string) {
  const real = globalThis.prompt;
  globalThis.prompt = (() => answer) as typeof globalThis.prompt;
  restorePrompt = () => {
    globalThis.prompt = real;
  };
}

describe("prune", () => {
  test("formatPlan says plainly when there is nothing to do", () => {
    expect(formatPlan([])).toBe("No run worktrees found. Nothing to prune.");
  });

  test("formatPlan lists each branch and path, and says branches are kept", () => {
    const text = formatPlan([
      { branch: "run/aaa", path: "/w/aaa" },
      { branch: "run/bbb", path: "/w/bbb" },
    ]);
    expect(text).toContain("2 run worktree(s)");
    expect(text).toContain("branches are kept");
    expect(text).toContain("run/aaa");
    expect(text).toContain("/w/bbb");
  });

  test("--yes removes every run worktree and keeps every branch", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const a = await ops.create("aaa");
    const b = await ops.create("bbb");
    writeFileSync(join(a.path, "work.txt"), "agent output\n");
    await git(["add", "-A"], a.path);
    await git(["commit", "-m", "agent work"], a.path);

    expect(await main(["--yes"])).toBe(0);

    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(await listRunWorktrees(repoPath)).toHaveLength(0);

    // The deliverable outlives the prune.
    const { stdout } = await git(["log", "--oneline", "-1", "run/aaa"], repoPath);
    expect(stdout).toContain("agent work");
    expect(logged.join("\n")).toContain("2/2 removed");
  });

  test("without --yes it asks, and a refusal removes nothing", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const a = await ops.create("aaa");
    stubPrompt("n");

    expect(await main([])).toBe(1);
    expect(existsSync(a.path)).toBe(true);
    expect(logged.join("\n")).toContain("Aborted");
  });

  test("a confirmed prompt removes them", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    const a = await ops.create("aaa");
    stubPrompt("y");

    expect(await main([])).toBe(0);
    expect(existsSync(a.path)).toBe(false);
  });

  test("nothing to prune exits 0 without asking anything", async () => {
    stubPrompt("this must never be read");
    expect(await main([])).toBe(0);
    expect(logged.join("\n")).toContain("Nothing to prune");
  });

  test("it never touches worktrees that are not runs", async () => {
    const ops = gitWorktreeOps(repoPath, worktreesDir);
    await ops.create("aaa");
    const manual = join(root, "manual");
    await git(["worktree", "add", "-b", "feature/x", manual, "origin/main"], repoPath);

    expect(await main(["--yes"])).toBe(0);
    expect(existsSync(manual)).toBe(true);
  });
});
