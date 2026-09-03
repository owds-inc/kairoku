/**
 * A dispatch becomes a team (§20.4) and survives a restart (RF-013).
 *
 * Everything here runs the REAL recipe over a FAKE provider: the fan-out, the
 * fix loops, the reports and the run files are the production ones, and the
 * only thing swapped out is the model. No network, no `claude`, no `codex`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimedDispatch, RunReport } from "./app";
import {
  checkoutMismatch,
  clearPendingReport,
  findPrUrl,
  memberName,
  pendingReports,
  processStartedBefore,
  readRunStates,
  recipeName,
  roleChoice,
  runStatePath,
  startDispatch,
  sweepRestarts,
  writeRunState,
} from "./dispatch";
import { RunStore } from "./runs";
import { rolePrompt, rolesWithPrompts } from "./roles";
import { ROLE_NAMES } from "./policy";
import { fakeApp, fakeItem, fakeProvider, harness, waitFor, type FakeProvider, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const CLEAN = { verdict: "CLEAN", defects: [] };

const claim = (over: Partial<ClaimedDispatch> = {}): ClaimedDispatch => ({
  id: "d1",
  taskType: "implement",
  brief: "",
  project: { id: "p1", slug: "kairoku" },
  target: { kind: "plan_item", id: "t1", title: "an item" },
  repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main", defaultBranchSource: "column" },
  team: { recipe: "build-verify", roles: {} },
  items: [fakeItem(1)],
  env: { profile: "test" },
  limits: { runSeconds: null },
  ...over,
});

interface Rig {
  h: Harness;
  store: RunStore;
  provider: FakeProvider;
  reports: RunReport[];
  run(dispatch: ClaimedDispatch, deps?: Record<string, unknown>): Promise<void>;
}

function rig(overrides: Record<string, unknown> = {}): Rig {
  const h = (active = harness(overrides));
  const store = new RunStore(h.config);
  const provider = fakeProvider();
  provider.script("reviewer", [{ report: CLEAN }]);
  const reports: RunReport[] = [];
  return {
    h,
    store,
    provider,
    reports,
    async run(dispatch, deps = {}) {
      const started = startDispatch(store, h.config, dispatch, {
        repoFullName: "owds-inc/kairoku",
        providers: { claude: provider, codex: provider },
        report: (report) => reports.push(report),
        findPrUrl: async () => "https://github.com/owds-inc/kairoku/pull/9",
        ...deps,
      });
      await started.finished;
    },
  };
}

/**
 * Let held turns through as they arrive. A `hold: true` script holds EVERY turn
 * of that role, which is what makes the capacity assertion above possible; this
 * is how the same test then lets the whole team finish.
 */
async function drain(finished: Promise<void>, provider: FakeProvider): Promise<void> {
  const pump = setInterval(() => provider.releaseAll(), 10);
  try {
    await finished;
  } finally {
    clearInterval(pump);
  }
}

describe("dispatch — what the claim says to run", () => {
  test("the team the app chose wins; otherwise the task type and target decide", () => {
    expect(recipeName(claim({ team: { recipe: "solo" } }))).toBe("solo");
    expect(recipeName(claim({ team: null }))).toBe("build-verify");
    expect(recipeName(claim({ team: null, target: { kind: "phase", id: "p", title: "" } }))).toBe("phase-team");
    expect(recipeName(claim({ team: null, taskType: "plan" }))).toBe("plan");
    expect(recipeName(claim({ team: null, taskType: "document" }))).toBe("research");
  });

  test("provider and model per role come from the team; Claude is the default", () => {
    const dispatch = claim({
      team: {
        recipe: "build-verify",
        roles: { implementer: { provider: "codex", model: "gpt-5.6-sol", effort: "high" } },
      },
    });
    expect(roleChoice(dispatch, "implementer")).toEqual({ provider: "codex", model: "gpt-5.6-sol", effort: "high" });
    expect(roleChoice(dispatch, "reviewer")).toEqual({ provider: "claude" });
  });

  test("an effort word the daemon does not know is dropped, not passed through", () => {
    const dispatch = claim({ team: { roles: { implementer: { effort: "maximum-overdrive" } } } });
    expect(roleChoice(dispatch, "implementer").effort).toBeUndefined();
  });

  test("one member branches run/<dispatch>; a team branches run/<dispatch>-<n>", () => {
    expect(memberName("d1", 0, 1)).toBe("d1");
    expect(memberName("d1", 0, 3)).toBe("d1-1");
    expect(memberName("d1", 2, 3)).toBe("d1-3");
  });

  test("§20.9 fails closed: a claim for another repo, or an unreadable checkout, is a mismatch", () => {
    expect(checkoutMismatch(claim(), "owds-inc/kairoku")).toBeUndefined();
    expect(checkoutMismatch(claim(), "OWDS-INC/Kairoku")).toBeUndefined();
    // The app should never send a `.git` suffix; this side normalises anyway.
    expect(checkoutMismatch(claim({ repo: { fullName: "owds-inc/kairoku.git" } }), "owds-inc/kairoku")).toBeUndefined();
    expect(checkoutMismatch(claim(), "someone/else")).toBe("owds-inc/kairoku");
    expect(checkoutMismatch(claim(), undefined)).toBe("owds-inc/kairoku");
    // A claim that names no repo at all is the app saying "wherever you are".
    expect(checkoutMismatch(claim({ repo: null }), undefined)).toBeUndefined();
  });
});

describe("dispatch — the refusals, each reported per run", () => {
  test("a claim for a repo this daemon has no checkout of is reported failed, not attempted", async () => {
    const r = rig();
    await r.run(claim({ items: [fakeItem(1), fakeItem(2)] }), { repoFullName: "someone/else" });
    expect(r.reports).toHaveLength(2);
    for (const report of r.reports) {
      expect(report).toMatchObject({ status: "failed", summary: "no checkout for owds-inc/kairoku" });
    }
    expect(r.h.worktrees.created).toHaveLength(0);
  });

  test("a team this daemon does not have is refused with the name it was asked for", async () => {
    const r = rig();
    await r.run(claim({ team: { recipe: "agent-led" } }));
    expect(r.reports[0]!.summary).toContain('no team called "agent-led"');
  });

  test("a claim with no items has nothing to run and says so", async () => {
    const r = rig();
    await r.run(claim({ items: [] }));
    expect(r.reports[0]).toMatchObject({ status: "failed", runId: "d1" });
    expect(r.reports[0]!.summary).toContain("no items");
  });

  test("an item with no run token and no fallback is refused before an agent starts", async () => {
    const r = rig({ agentToken: undefined });
    await r.run(claim({ items: [fakeItem(1, { runToken: "" })] }), { agentToken: undefined });
    expect(r.reports[0]!.summary).toContain("no credential");
    expect(r.provider.launched).toHaveLength(0);
  });
});

describe("dispatch — one member, end to end", () => {
  test("running at launch, then done with the branch, the PR and four counts", async () => {
    const r = rig();
    r.provider.script("implementer", [{ events: [{ kind: "text", text: "building" }] }]);
    await r.run(claim({ team: { recipe: "solo" } }), {
      // The QA step is deterministic; here it is the whole of what is stubbed.
      findPrUrl: async () => "https://github.com/owds-inc/kairoku/pull/9",
    });

    const [first, last] = [r.reports[0]!, r.reports.at(-1)!];
    expect(first).toMatchObject({ dispatchId: "d1", runId: "run-1", status: "running", state: "running" });
    expect(last).toMatchObject({
      dispatchId: "d1",
      runId: "run-1",
      status: "failed", // no test command in a fake worktree — QA fails closed
      artifacts: { branch: "run/d1", prUrl: "https://github.com/owds-inc/kairoku/pull/9" },
    });
    expect(last.summary).toContain("no test command");
  });

  test("every run says `running` exactly once at launch (§20 addendum 6)", async () => {
    const r = rig();
    await r.run(claim({ items: [fakeItem(1), fakeItem(2)], team: { recipe: "phase-team" } }));
    const running = r.reports.filter((report) => report.status === "running");
    expect(running.map((report) => report.runId).sort()).toEqual(["run-1", "run-2"]);
  });

  test("the run's own token is what the agent gets, and it never reaches an event", async () => {
    const r = rig();
    r.provider.script("implementer", [{ events: [{ kind: "text", text: "my token is kai_run_token_1" }] }]);
    await r.run(claim({ team: { recipe: "solo" } }));
    expect(r.provider.launched[0]!.env.KAIROKU_PAT).toBe("kai_run_token_1");
    const log = readFileSync(join(r.h.config.runsDir, "d1", "run-1.jsonl"), "utf8");
    expect(log).toContain("my token is");
    expect(log).not.toContain("kai_run_token_1");
  });

  test("the reviewer is asked for a structured verdict; the implementer is not", async () => {
    const r = rig();
    await r.run(claim());
    const roles = r.provider.launched.map((run) => [run.role, run.schema !== undefined]);
    expect(roles.slice(0, 2)).toEqual([
      ["implementer", false],
      ["reviewer", true],
    ]);
    // Every later turn is a fix round, and a fix round is an implementer.
    expect(roles.slice(2).every(([role]) => role === "implementer")).toBe(true);
  });

  test("the item's six-section body is the brief, with the human's note appended", async () => {
    const r = rig();
    await r.run(claim({ brief: "also: keep the diff small" }));
    const prompt = r.provider.launched[0]!.prompt;
    expect(prompt).toContain("Do thing 1.");
    expect(prompt).toContain("also: keep the diff small");
  });
});

describe("dispatch — a phase team", () => {
  test("three items on a capacity-2 machine run two at a time, each on its own branch", async () => {
    const r = rig({ maxConcurrent: 2 });
    r.provider.script("implementer", [{ hold: true }]);

    const dispatch = claim({
      team: { recipe: "phase-team" },
      items: [fakeItem(1), fakeItem(2), fakeItem(3)],
    });
    const started = startDispatch(r.store, r.h.config, dispatch, {
      repoFullName: "owds-inc/kairoku",
      providers: { claude: r.provider, codex: r.provider },
      report: (report) => r.reports.push(report),
      findPrUrl: async () => undefined,
    });

    await waitFor(() => r.provider.launched.length === 2, "two members at once");
    expect(r.store.capacity()).toEqual({ running: 2, max: 2 });
    // The third has not started: capacity is the bound, not a suggestion.
    await Bun.sleep(30);
    expect(r.provider.launched).toHaveLength(2);

    await drain(started.finished, r.provider);

    expect(r.h.worktrees.created.map((w) => w.branch).sort()).toEqual(["run/d1-1", "run/d1-2", "run/d1-3"]);
    expect(started.runIds).toEqual(["run-1", "run-2", "run-3"]);
  });

  test("cancelling one member interrupts that member and leaves the others alone", async () => {
    const r = rig({ maxConcurrent: 3 });
    r.provider.script("implementer", [{ hold: true }]);

    const dispatch = claim({ team: { recipe: "phase-team" }, items: [fakeItem(1), fakeItem(2), fakeItem(3)] });
    const started = startDispatch(r.store, r.h.config, dispatch, {
      repoFullName: "owds-inc/kairoku",
      providers: { claude: r.provider, codex: r.provider },
      report: (report) => r.reports.push(report),
      findPrUrl: async () => undefined,
    });
    await waitFor(() => r.store.list().length === 3, "all three members");

    expect(r.store.cancel("run-2")).toBe(true);
    await waitFor(() => r.reports.some((x) => x.runId === "run-2" && x.status === "failed"), "run-2 to settle");
    expect(r.reports.find((x) => x.runId === "run-2" && x.status === "failed")!.summary).toBe("cancelled by the app");
    expect(r.store.list().map((x) => x.runId).sort()).toEqual(["run-1", "run-3"]);

    await drain(started.finished, r.provider);
  });
});

describe("dispatch — the run file (RF-013)", () => {
  test("one file per run under the dispatch's dir, carrying branch, pid and worktree", async () => {
    const r = rig();
    await r.run(claim({ team: { recipe: "solo" }, items: [fakeItem(1), fakeItem(2)] }));
    for (const runId of ["run-1", "run-2"]) {
      const path = runStatePath(r.h.config.runsDir, "d1", runId);
      expect(existsSync(path)).toBe(true);
      const state = JSON.parse(readFileSync(path, "utf8"));
      expect(state).toMatchObject({ dispatchId: "d1", runId, state: "failed", pid: process.pid });
      expect(state.branch).toContain("run/d1");
      expect(state.report).toMatchObject({ runId, status: "failed" });
    }
  });

  test("the session id is recorded so a human can resume the same session", async () => {
    const r = rig();
    r.provider.script("implementer", [{ sessionId: "sess-abc" }]);
    await r.run(claim({ team: { recipe: "solo" } }));
    const state = JSON.parse(readFileSync(runStatePath(r.h.config.runsDir, "d1", "run-1"), "utf8"));
    expect(state.sessionId).toBe("sess-abc");
  });

  test("a leftover whose owner is gone is reaped, reported failed, and NEVER relaunched", async () => {
    const h = (active = harness());
    writeRunState(h.config.runsDir, {
      dispatchId: "d-old",
      runId: "run-old",
      state: "running",
      pid: 999_999,
      startedAt: new Date().toISOString(),
      branch: "run/d-old",
    });
    const stranded = await sweepRestarts(h.config.runsDir, { owned: async () => false });
    expect(stranded.map((s) => s.runId)).toEqual(["run-old"]);
    expect(JSON.parse(readFileSync(runStatePath(h.config.runsDir, "d-old", "run-old"), "utf8")).state).toBe("failed");
    // A second boot finds nothing: the reap is idempotent.
    expect(await sweepRestarts(h.config.runsDir, { owned: async () => false })).toEqual([]);
  });

  test("a leftover a LIVE daemon still owns is left alone — pid AND start time", async () => {
    const h = (active = harness());
    const startedAt = new Date().toISOString();
    writeRunState(h.config.runsDir, {
      dispatchId: "d-live",
      runId: "run-live",
      state: "running",
      pid: 4242,
      startedAt,
      branch: "run/d-live",
    });
    const seen: Array<[number, string]> = [];
    const stranded = await sweepRestarts(h.config.runsDir, {
      selfPid: 1,
      owned: async (pid, at) => {
        seen.push([pid, at]);
        return true;
      },
    });
    expect(stranded).toEqual([]);
    expect(seen).toEqual([[4242, startedAt]]);
  });

  test("our OWN pid on a run we did not start means the number was recycled — reap it", async () => {
    const h = (active = harness());
    writeRunState(h.config.runsDir, {
      dispatchId: "d-me",
      runId: "run-me",
      state: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      branch: "run/d-me",
    });
    let asked = false;
    const stranded = await sweepRestarts(h.config.runsDir, {
      owned: async () => {
        asked = true;
        return true;
      },
    });
    expect(stranded.map((s) => s.runId)).toEqual(["run-me"]);
    expect(asked).toBe(false);
  });

  test("a terminal leftover is not touched", async () => {
    const h = (active = harness());
    for (const state of ["done", "failed"] as const) {
      writeRunState(h.config.runsDir, {
        dispatchId: `d-${state}`,
        runId: `run-${state}`,
        state,
        startedAt: new Date().toISOString(),
        branch: "b",
      });
    }
    expect(await sweepRestarts(h.config.runsDir, { owned: async () => false })).toEqual([]);
  });

  test("processStartedBefore reads the OS, and an unreadable pid is treated as gone", async () => {
    const started = new Date().toISOString();
    expect(
      await processStartedBefore(1, started, async () => ({ code: 0, stdout: "Mon Jan  1 00:00:00 2001", stderr: "" })),
    ).toBe(true);
    expect(await processStartedBefore(1, started, async () => ({ code: 1, stdout: "", stderr: "" }))).toBe(false);
    expect(await processStartedBefore(1, started, async () => ({ code: 0, stdout: "gibberish", stderr: "" }))).toBe(
      false,
    );
    expect(
      await processStartedBefore(1, started, async () => {
        throw new Error("no ps here");
      }),
    ).toBe(false);
  });
});

describe("dispatch — the pending terminal report (§20 item 9)", () => {
  test("a terminal report is persisted with the run and read back on boot", async () => {
    const r = rig();
    await r.run(claim({ team: { recipe: "solo" } }));
    const pending = pendingReports(r.h.config.runsDir);
    expect(pending.map((p) => p.runId)).toEqual(["run-1"]);
    expect(pending[0]).toMatchObject({ status: "failed", dispatchId: "d1" });
  });

  test("clearing it leaves the rest of the run file intact", async () => {
    const r = rig();
    await r.run(claim({ team: { recipe: "solo" } }));
    clearPendingReport(r.h.config.runsDir, "d1", "run-1");
    expect(pendingReports(r.h.config.runsDir)).toEqual([]);
    const state = readRunStates(r.h.config.runsDir)[0]!;
    expect(state).toMatchObject({ dispatchId: "d1", runId: "run-1", state: "failed" });
    expect(state.report).toBeUndefined();
  });

  test("clearing a report that is not there is not an error", () => {
    const h = (active = harness());
    expect(() => clearPendingReport(h.config.runsDir, "nope", "nope")).not.toThrow();
  });
});

describe("dispatch — codex role prompts", () => {
  test("every role the policy knows has a prompt the daemon can write", () => {
    expect(rolesWithPrompts().sort()).toEqual([...ROLE_NAMES].sort());
    for (const role of ROLE_NAMES) {
      expect(rolePrompt(role).length).toBeGreaterThan(200);
      expect(rolePrompt(role).toLowerCase()).toContain(role);
    }
  });

  test("the implementer's prompt says it may never mark an item done", () => {
    expect(rolePrompt("implementer")).toContain("`done`");
    expect(rolePrompt("implementer").toLowerCase()).toContain("never mark a plan item");
  });

  test("the reviewer's prompt says it never edits and must return a verdict", () => {
    expect(rolePrompt("reviewer")).toContain("CLEAN");
    expect(rolePrompt("reviewer")).toContain("NOT_CLEAN");
    expect(rolePrompt("reviewer").toLowerCase()).toContain("never edit");
  });
});

describe("dispatch — the fake app is still the shape the real one answers", () => {
  test("a claim carries items with run ids and per-run tokens", async () => {
    const app = fakeApp();
    app.queue({ id: "d1", taskType: "implement", items: [fakeItem(1)] });
    const res = await fetch(`${app.url}/api/daemon/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
    });
    const body = (await res.json()) as { dispatch: ClaimedDispatch };
    expect(body.dispatch.items?.[0]).toMatchObject({ runId: "run-1", runToken: "kai_run_token_1" });
    await app.stop();
  });
});

describe("dispatch — the PR url, asked of whichever forge CLI is installed", () => {
  const deps = (has: string[], answers: Record<string, { code: number; stdout: string }>) => ({
    which: (bin: string) => (has.includes(bin) ? `/usr/local/bin/${bin}` : null),
    exec: async (argv: string[]) => ({ stderr: "", ...(answers[argv[0]!] ?? { code: 1, stdout: "" }) }),
  });

  test("gh answers first when it is there", async () => {
    const url = await findPrUrl(
      "/repo",
      "run/d1",
      deps(["gh", "glab"], { "/usr/local/bin/gh": { code: 0, stdout: "https://github.com/o/r/pull/1\n" } }),
    );
    expect(url).toBe("https://github.com/o/r/pull/1");
  });

  test("the RESOLVED path is what runs, not the bare name", async () => {
    // `which` and `spawn` answering from two different PATHs is how a lookup
    // checks one binary and then runs another.
    const ran: string[][] = [];
    await findPrUrl("/repo", "run/d1", {
      which: (bin) => `/opt/kairoku/bin/${bin}`,
      exec: async (argv) => {
        ran.push(argv);
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    expect(ran[0]![0]).toBe("/opt/kairoku/bin/gh");
    expect(ran[1]![0]).toBe("/opt/kairoku/bin/glab");
  });

  test("glab's json is read when gh is not installed", async () => {
    const url = await findPrUrl(
      "/repo",
      "run/d1",
      deps(["glab"], {
        "/usr/local/bin/glab": { code: 0, stdout: JSON.stringify({ web_url: "https://gitlab.com/o/r/-/merge_requests/2" }) },
      }),
    );
    expect(url).toBe("https://gitlab.com/o/r/-/merge_requests/2");
  });

  test("no forge CLI, no PR, or unparseable output is `undefined` — not an error", async () => {
    expect(await findPrUrl("/repo", "b", deps([], {}))).toBeUndefined();
    expect(await findPrUrl("/repo", "b", deps(["gh"], { "/usr/local/bin/gh": { code: 1, stdout: "" } }))).toBeUndefined();
    expect(
      await findPrUrl("/repo", "b", deps(["glab"], { "/usr/local/bin/glab": { code: 0, stdout: "not json" } })),
    ).toBeUndefined();
    // A non-http answer is not a url, whatever the exit code said.
    expect(
      await findPrUrl("/repo", "b", deps(["gh"], { "/usr/local/bin/gh": { code: 0, stdout: "no pull requests found" } })),
    ).toBeUndefined();
  });
});
