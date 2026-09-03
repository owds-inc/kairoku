/**
 * §21 Q15/Q19 — CodeGraph on probation: the index step, and the two MCP shapes
 * it is handed to a run through.
 *
 * NO TEST HERE INVOKES REAL CodeGraph. `which` and `exec` are seams, exactly as
 * `rules.ts` does it, so the daemon's behaviour on a machine with no CodeGraph
 * is a test rather than a hope.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEGRAPH,
  CODEGRAPH_DIR,
  CODEGRAPH_NOTE,
  codegraphMcpServers,
  codegraphTomlTable,
  indexWorktree,
  type CodeGraph,
} from "./codegraph";
import { run as exec } from "./worktree";

const BIN = "/opt/homebrew/bin/codegraph";
const OK = { code: 0, stdout: "", stderr: "" };
const STATUS = JSON.stringify({ initialized: true, fileCount: 573, nodeCount: 9012 });

interface Calls {
  readonly argv: string[][];
  readonly cwds: string[];
}

function fakeExec(answers: Record<string, { code: number; stdout: string; stderr: string }> = {}): {
  calls: Calls;
  exec: (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const calls: Calls = { argv: [], cwds: [] };
  return {
    calls,
    exec: async (argv, cwd) => {
      calls.argv.push(argv);
      calls.cwds.push(cwd);
      return answers[argv[1] ?? ""] ?? OK;
    },
  };
}

/** A clock that advances a fixed amount on every read, so the wall clock is exact. */
function clock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs) - stepMs;
}

describe("indexWorktree — §21 item 2, the index before the role launches", () => {
  test("indexes the worktree and reports the file count and the wall clock as ONE line", async () => {
    const { calls, exec } = fakeExec({ status: { ...OK, stdout: STATUS } });
    const result = await indexWorktree("/wt", { which: () => BIN, exec, now: clock(1_200) });

    expect(calls.argv[0]).toEqual([BIN, "init", "/wt"]);
    expect(calls.cwds[0]).toBe("/wt");
    expect(result.event).toBe("codegraph: 573 files in 1.2s");
    expect(result.codegraph).toEqual({ bin: BIN, worktree: "/wt" });
  });

  test("the RESOLVED path is what runs, never the bare name (rule 3's own lesson)", async () => {
    const { calls, exec } = fakeExec({ status: { ...OK, stdout: STATUS } });
    await indexWorktree("/wt", { which: () => BIN, exec, now: clock(0) });
    for (const argv of calls.argv) expect(argv[0]).toBe(BIN);
    expect(calls.argv.some((argv) => argv[0] === CODEGRAPH)).toBe(false);
  });

  test("no CodeGraph on this machine DEGRADES SILENTLY: nothing runs, nothing is handed over, no event", async () => {
    const { calls, exec } = fakeExec();
    const result = await indexWorktree("/wt", { which: () => null, exec, now: clock(0) });
    expect(calls.argv).toEqual([]);
    expect(result).toEqual({});
  });

  test("an index that FAILS leaves the run without CodeGraph and says so — never a run failure", async () => {
    const { exec } = fakeExec({ init: { code: 1, stdout: "", stderr: "lock held by another process" } });
    const result = await indexWorktree("/wt", { which: () => BIN, exec, now: clock(500) });
    expect(result.codegraph).toBeUndefined();
    expect(result.event).toContain("codegraph: not indexed");
    expect(result.event).toContain("lock held by another process");
  });

  test("a status this daemon cannot read still leaves the index ON — the count is the only thing lost", async () => {
    const { exec } = fakeExec({ status: { ...OK, stdout: "not json at all" } });
    const result = await indexWorktree("/wt", { which: () => BIN, exec, now: clock(2_500) });
    expect(result.codegraph).toEqual({ bin: BIN, worktree: "/wt" });
    expect(result.event).toBe("codegraph: indexed in 2.5s");
  });

  test("a codegraph that cannot be spawned at all is the same silent degrade, not a throw", async () => {
    const result = await indexWorktree("/wt", {
      which: () => BIN,
      exec: async () => {
        throw new Error("ENOENT");
      },
      now: clock(0),
    });
    expect(result.codegraph).toBeUndefined();
    expect(result.event).toContain("codegraph: not indexed");
  });
});

describe("indexWorktree — the index is the daemon's plumbing, not the agent's diff", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function linkedWorktree(): Promise<{ repo: string; wt: string }> {
    const root = mkdtempSync(join(tmpdir(), "kairoku-codegraph-"));
    dirs.push(root);
    const repo = join(root, "repo");
    await exec(["git", "init", "-q", "-b", "main", repo], root);
    await exec(["git", "config", "user.email", "t@example.com"], repo);
    await exec(["git", "config", "user.name", "t"], repo);
    await Bun.write(join(repo, "README.md"), "hi\n");
    await exec(["git", "add", "-A"], repo);
    await exec(["git", "commit", "-qm", "init"], repo);
    const wt = join(root, "wt");
    await exec(["git", "worktree", "add", "-q", wt, "-b", "run/x", "HEAD"], repo);
    return { repo, wt };
  }

  test(`${CODEGRAPH_DIR}/ is excluded from git, so the implementer cannot commit the index`, async () => {
    const { repo, wt } = await linkedWorktree();
    // The real thing writes `.codegraph/`; the fake exec does not, so the test
    // writes the directory itself and asks git whether the tree is still clean.
    const { exec: fake } = fakeExec({ status: { ...OK, stdout: STATUS } });
    await indexWorktree(wt, { which: () => BIN, exec: fake, now: clock(0) });
    await Bun.write(join(wt, CODEGRAPH_DIR, "codegraph.db"), "binary");

    expect(await Bun.file(join(repo, ".git", "info", "exclude")).text()).toContain(`${CODEGRAPH_DIR}/`);
    const status = await exec(["git", "status", "--porcelain"], wt);
    expect(status.stdout).toBe("");
  });
});

describe("the two MCP shapes — one server, two hosts", () => {
  const cg: CodeGraph = { bin: BIN, worktree: "/wt" };

  test("Claude gets a stdio server PINNED to this run's worktree", () => {
    // One index per worktree is not a choice: CodeGraph refuses to share one
    // across worktrees, so the project path must be stated rather than inferred
    // from a client rootUri the daemon never sends.
    expect(codegraphMcpServers(cg)).toEqual({
      codegraph: { type: "stdio", command: BIN, args: ["serve", "--mcp", "-p", "/wt"] },
    });
  });

  test("Codex gets the same server as a TOML table", () => {
    const toml = codegraphTomlTable(cg);
    expect(toml).toContain("[mcp_servers.codegraph]");
    expect(toml).toContain(`command = ${JSON.stringify(BIN)}`);
    expect(toml).toContain('args = ["serve", "--mcp", "-p", "/wt"]');
  });

  test("the sentence the role prompts get names the tool and the discipline", () => {
    expect(CODEGRAPH_NOTE).toContain("codegraph_explore");
    expect(CODEGRAPH_NOTE).toContain("read the file before you edit it");
  });
});
