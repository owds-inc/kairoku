/**
 * A dispatch becomes a run (RF-012's `solo` half, RF-013).
 *
 * The daemon reports FACTS and the app decides: a branch, a PR url if the
 * agent opened one, the four counts if the agent cited a suite, and the local
 * jsonl path. Nothing here interprets whether the work was good.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimedDispatch } from "./app";
import {
  findPrUrl,
  parseCounts,
  readRunStates,
  runStatePath,
  startDispatch,
  sweepRestarts,
  writeRunState,
} from "./dispatch";
import { eventsPath, ensureRunDir } from "./events";
import { RunStore } from "./runs";
import { harness, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function setup(overrides = {}) {
  const h = (active = harness(overrides));
  return { h, store: new RunStore(h.config) };
}

const dispatch = (extra: Partial<ClaimedDispatch> = {}): ClaimedDispatch => ({
  id: "d-1",
  targetKind: "plan_item",
  targetId: "t-1",
  taskType: "implement",
  brief: "Build the thing.",
  createdAt: new Date().toISOString(),
  ...extra,
});

describe("counts come from the agent's final report block", () => {
  test("the last kairoku block wins, and a partial count set is not a count", () => {
    expect(parseCounts('noise\n{"kairoku": {"counts": {"pass": 1, "fail": 0, "skip": 0, "errors": 0}}}\n')).toEqual({
      pass: 1,
      fail: 0,
      skip: 0,
      errors: 0,
    });
    expect(
      parseCounts(
        '{"kairoku": {"counts": {"pass": 1, "fail": 0, "skip": 0, "errors": 0}}}\n' +
          '{"kairoku": {"counts": {"pass": 4955, "fail": 0, "skip": 2, "errors": 0}}}\n',
      ),
    ).toEqual({ pass: 4955, fail: 0, skip: 2, errors: 0 });
    // Three of four is not a count (the app refuses it too).
    expect(parseCounts('{"kairoku": {"counts": {"pass": 1, "fail": 0, "skip": 0}}}')).toBeUndefined();
    expect(parseCounts("nothing here")).toBeUndefined();
  });

  test("the block still parses when codex has wrapped it in a JSONL string", () => {
    // `codex exec --json` prints events, and the agent's own text arrives as a
    // JSON string value — so the braces the block needs are escaped.
    const line = JSON.stringify({
      type: "item.completed",
      text: 'done\n{"kairoku": {"counts": {"pass": 12, "fail": 0, "skip": 1, "errors": 0}}}',
    });
    expect(parseCounts(line)).toEqual({ pass: 12, fail: 0, skip: 1, errors: 0 });
  });
});

describe("the PR url is looked up, never invented", () => {
  const calls: string[][] = [];
  const exec =
    (answers: Record<string, { code: number; stdout: string }>) =>
    async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      calls.push(argv);
      const hit = answers[argv[0]!] ?? { code: 1, stdout: "" };
      return { ...hit, stderr: "" };
    };

  test("gh answers with the url", async () => {
    calls.length = 0;
    const url = await findPrUrl("/repo", "run/d-1", {
      which: (bin) => bin === "gh",
      exec: exec({ gh: { code: 0, stdout: "https://github.com/owds-inc/kairoku/pull/7\n" } }),
    });
    expect(url).toBe("https://github.com/owds-inc/kairoku/pull/7");
    expect(calls[0]).toEqual(["gh", "pr", "view", "run/d-1", "--json", "url", "--jq", ".url"]);
  });

  test("glab is asked when gh is not installed", async () => {
    calls.length = 0;
    const url = await findPrUrl("/repo", "run/d-1", {
      which: (bin) => bin === "glab",
      exec: exec({ glab: { code: 0, stdout: JSON.stringify({ web_url: "https://gitlab.com/x/y/-/merge_requests/3" }) } }),
    });
    expect(url).toBe("https://gitlab.com/x/y/-/merge_requests/3");
    expect(calls[0]?.[0]).toBe("glab");
  });

  test("no PR is not an error — the branch is still the deliverable", async () => {
    expect(await findPrUrl("/repo", "run/d-1", { which: () => false, exec: exec({}) })).toBeUndefined();
    expect(await findPrUrl("/repo", "run/d-1", { which: () => true, exec: exec({}) })).toBeUndefined();
  });
});

describe("run.json is the one piece of state that must survive a restart", () => {
  test("it moves starting → running → done and records the pid, branch and worktree", async () => {
    const { h, store } = setup({
      commandOverride: () => ["sh", "-c", "echo '{\"kairoku\": {\"counts\": {\"pass\": 3, \"fail\": 0, \"skip\": 0, \"errors\": 0}}}'"],
    });
    const seen: string[] = [];
    const started = startDispatch(store, h.config, dispatch(), {
      agentToken: "kai_agent_fallback",
      onRunning: () => seen.push("running"),
      findPrUrl: async () => undefined,
    });
    expect(started.branch).toBe("run/d-1");

    const report = await started.finished;
    expect(seen).toEqual(["running"]);
    expect(report.status).toBe("done");
    expect(report.counts).toEqual({ pass: 3, fail: 0, skip: 0, errors: 0 });
    expect(report.artifacts.branch).toBe("run/d-1");
    expect(report.artifacts.jsonl).toBe(eventsPath(h.config.runsDir, "d-1"));

    const state = JSON.parse(readFileSync(runStatePath(h.config.runsDir, "d-1"), "utf8"));
    expect(state).toMatchObject({ dispatchId: "d-1", state: "done", branch: "run/d-1" });
    expect(typeof state.pid).toBe("number");
  });

  test("a failing agent is reported failed with its exit summary, and the counts still travel", async () => {
    const { h, store } = setup({ commandOverride: () => ["sh", "-c", "exit 3"] });
    const report = await startDispatch(store, h.config, dispatch(), {
      agentToken: "kai_agent_fallback",
      findPrUrl: async () => undefined,
    }).finished;
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("exit 3");
  });

  test("the worktree is cut from origin/<defaultBranch>, the claim's branch winning over the config's", async () => {
    const { h, store } = setup({ defaultBranch: "trunk" });
    await startDispatch(store, h.config, dispatch(), { agentToken: "t", findPrUrl: async () => undefined }).finished;
    expect(h.worktrees.bases[0]).toBe("origin/trunk");

    await startDispatch(
      store,
      h.config,
      dispatch({ id: "d-2", repo: { fullName: "owds-inc/kairoku", defaultBranch: "release" } }),
      { agentToken: "t", findPrUrl: async () => undefined, repoFullName: "owds-inc/kairoku" },
    ).finished;
    expect(h.worktrees.bases[1]).toBe("origin/release");
  });
});

describe("the run token, and the refusals that are reported rather than hung on", () => {
  test("the claim's run token is what the agent gets; the configured fallback is the else", async () => {
    const { h, store } = setup({
      commandOverride: () => ["sh", "-c", `printenv KAIROKU_PAT > ${join(active!.dir, "pat.txt")}`],
    });
    await startDispatch(store, h.config, dispatch({ items: [{ id: "i", runToken: "kai_run_scoped" }] }), {
      agentToken: "kai_agent_fallback",
      findPrUrl: async () => undefined,
    }).finished;
    expect(readFileSync(join(h.dir, "pat.txt"), "utf8").trim()).toBe("kai_run_scoped");

    await startDispatch(store, h.config, dispatch({ id: "d-2" }), {
      agentToken: "kai_agent_fallback",
      findPrUrl: async () => undefined,
    }).finished;
    expect(readFileSync(join(h.dir, "pat.txt"), "utf8").trim()).toBe("kai_agent_fallback");
  });

  test("a claim for a repo this daemon has no checkout of is reported failed, never hung on", async () => {
    const { h, store } = setup();
    const report = await startDispatch(
      store,
      h.config,
      dispatch({ repo: { fullName: "someone/else", defaultBranch: "main" } }),
      { agentToken: "t", repoFullName: "owds-inc/kairoku", findPrUrl: async () => undefined },
    ).finished;
    expect(report.status).toBe("failed");
    expect(report.summary).toBe("no checkout for someone/else");
    // Nothing was cut, nothing was launched.
    expect(h.worktrees.created).toHaveLength(0);
  });

  test("no run token and no fallback is reported failed, not run without a credential", async () => {
    const { h, store } = setup();
    const report = await startDispatch(store, h.config, dispatch(), { findPrUrl: async () => undefined }).finished;
    expect(report.status).toBe("failed");
    expect(report.summary).toMatch(/KAIROKU_AGENT_TOKEN/);
    expect(h.worktrees.created).toHaveLength(0);
  });
});

describe("RF-013 — the restart rule", () => {
  test("a non-terminal run with a dead pid is reported failed, and NEVER relaunched", () => {
    const { h } = setup();
    const runsDir = h.config.runsDir;
    for (const id of ["dead", "alive", "settled"]) ensureRunDir(runsDir, id);
    writeRunState(runsDir, { dispatchId: "dead", state: "running", pid: 999_999, startedAt: "t", branch: "run/dead" });
    writeRunState(runsDir, { dispatchId: "alive", state: "running", pid: process.pid, startedAt: "t", branch: "run/alive" });
    writeRunState(runsDir, { dispatchId: "settled", state: "done", pid: 999_999, startedAt: "t", branch: "run/settled" });

    const swept = sweepRestarts(runsDir);
    expect(swept.map((s) => s.dispatchId)).toEqual(["dead"]);
    // Marked on disk, so a second boot does not report it twice.
    expect(readRunStates(runsDir).find((s) => s.dispatchId === "dead")?.state).toBe("failed");
    expect(sweepRestarts(runsDir)).toHaveLength(0);
    // The live one is left exactly as it was.
    expect(readRunStates(runsDir).find((s) => s.dispatchId === "alive")?.state).toBe("running");
  });

  test("an unreadable run.json is skipped rather than crashing the boot", () => {
    const { h } = setup();
    ensureRunDir(h.config.runsDir, "junk");
    writeFileSync(runStatePath(h.config.runsDir, "junk"), "{ not json");
    expect(sweepRestarts(h.config.runsDir)).toEqual([]);
  });
});
