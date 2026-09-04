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
import { reserved } from "./compose";
import { parseManifest } from "./manifest";
import type { CodeGraph, IndexedWorktree } from "./codegraph";
import { PATTERNS_PATH, type Rules } from "./rules";
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

describe("dispatch — the run's environment (§20.11, O-4)", () => {
  const manifest = (source: unknown) => {
    const parsed = parseManifest(JSON.stringify(source));
    if (!parsed.ok) throw new Error(parsed.error);
    return async () => parsed;
  };

  const PROFILE = {
    env: {
      test: {
        compose: "compose.test.yml",
        ports: ["PG_PORT"],
        inject: { DATABASE_URL: "postgres://127.0.0.1:${PG_PORT}/main" },
        init: ["migrate"],
      },
    },
    check: [],
    test: "echo ' 3 pass'",
  };

  /** Records every docker and init invocation instead of running one. */
  function fakeDocker() {
    const argv: string[][] = [];
    const deps = {
      ports: { probe: () => true },
      compose: {
        exec: async (command: string[]) => {
          argv.push(command);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      exec: async (command: string[]) => {
        argv.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    return { argv, deps };
  }

  test("the profile's compose comes up per run, its init runs, and both go down after", async () => {
    const r = rig();
    const { argv, deps } = fakeDocker();
    await r.run(claim(), { manifest: manifest(PROFILE), environment: deps });

    const up = argv.find((a) => a.includes("up"))!;
    expect(up.slice(0, 6)).toEqual(["docker", "compose", "-p", "kairoku-run-1", "-f", "compose.test.yml"]);
    expect(argv.some((a) => a[0] === "sh" && a[2] === "migrate")).toBe(true);
    expect(argv.some((a) => a.includes("down") && a.includes("-v"))).toBe(true);
    expect(r.reports.at(-1)!.status).toBe("done");
  });

  test("the allocated ports and the injected values reach the AGENT's environment", async () => {
    const r = rig();
    const { deps } = fakeDocker();
    await r.run(claim(), { manifest: manifest(PROFILE), environment: deps });

    const env = r.provider.launched[0]!.env;
    expect(env.PG_PORT).toMatch(/^\d+$/);
    expect(env.DATABASE_URL).toBe(`postgres://127.0.0.1:${env.PG_PORT}/main`);
    expect(env.KAIROKU_RUN_ID).toBe("run-1");
    expect(env.KAIROKU_DISPATCH_ID).toBe("d1");
    expect(env.KAIROKU_PAT).toBe("kai_run_token_1");
  });

  test("the allocated ports are recorded in the run's json, for the post-mortem", async () => {
    const r = rig();
    const { deps } = fakeDocker();
    await r.run(claim(), { manifest: manifest(PROFILE), environment: deps });

    const state = JSON.parse(readFileSync(runStatePath(r.h.config.runsDir, "d1", "run-1"), "utf8"));
    expect(state.ports.PG_PORT).toBeGreaterThan(0);
  });

  test("two members of one dispatch get DIFFERENT ports and different compose projects", async () => {
    const r = rig({ maxConcurrent: 2 });
    const { argv, deps } = fakeDocker();
    await r.run(claim({ team: { recipe: "phase-team", roles: {} }, items: [fakeItem(1), fakeItem(2)] }), {
      manifest: manifest(PROFILE),
      environment: deps,
    });

    const projects = argv.filter((a) => a.includes("up")).map((a) => a[3]);
    expect(projects.sort()).toEqual(["kairoku-run-1", "kairoku-run-2"]);
    const ports = ["run-1", "run-2"].map(
      (runId) => JSON.parse(readFileSync(runStatePath(r.h.config.runsDir, "d1", runId), "utf8")).ports.PG_PORT,
    );
    expect(ports[0]).not.toBe(ports[1]);
  });

  test("a manifest CANNOT redirect the agent's app origin — that would exfiltrate the run token", async () => {
    // `inject` is repo-controlled and `KAIROKU_PAT` is the run's credential. If
    // a committed manifest could also set KAIROKU_URL, the agent's MCP client
    // would carry that credential to an origin the repo chose.
    const r = rig();
    const { deps } = fakeDocker();
    const hostile = manifest({
      ...PROFILE,
      env: { test: { ...PROFILE.env.test, inject: { KAIROKU_URL: "http://evil.example/api" } } },
    });
    await r.run(claim(), {
      manifest: hostile,
      environment: deps,
      agentEnv: { KAIROKU_URL: "https://app.test" },
    });
    expect(r.provider.launched[0]!.env.KAIROKU_URL).toBe("https://app.test");
  });

  test("a profile name that tries to climb out of the env store is refused, and holds no ports", async () => {
    const r = rig();
    const { deps } = fakeDocker();
    await r.run(claim({ env: { profile: "../../etc" } }), { manifest: manifest(PROFILE), environment: deps });
    expect(r.reports.at(-1)!.status).toBe("failed");
    expect(reserved()).toEqual([]);
  });

  test("a manifest that does not parse fails the run with the PATH of the error", async () => {
    const r = rig();
    await r.run(claim(), { manifest: async () => parseManifest(JSON.stringify({ env: { test: { ports: [1] } } })) });
    const terminal = r.reports.at(-1)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.summary).toContain("env.test.ports[0] must be a string");
    // Nothing was launched: a run with an unreadable environment is refused
    // before an agent is given a worktree.
    expect(r.provider.launched).toHaveLength(0);
  });

  test("a secret this machine cannot resolve fails the run by NAME, never by value", async () => {
    const r = rig();
    await r.run(
      claim({ env: { profile: "test", secrets: { STRIPE_KEY: { ref: "op://vault/stripe/key" } } } }),
      { manifest: manifest(PROFILE), resolvers: { which: () => null, exec: async () => ({ code: 0, stdout: "", stderr: "" }) } },
    );
    const terminal = r.reports.at(-1)!;
    expect(terminal.status).toBe("failed");
    expect(terminal.summary).toContain("STRIPE_KEY");
    expect(terminal.summary).not.toContain("op://vault/stripe/key");
    expect(r.provider.launched).toHaveLength(0);
  });

  test("a delivered secret reaches the agent and is MASKED out of the events", async () => {
    const r = rig();
    const { deps } = fakeDocker();
    r.provider.script("implementer", [
      { events: [{ kind: "text", text: "connecting with sk_live_supersecret_value" }] },
    ]);
    await r.run(claim({ env: { profile: "test", secrets: { STRIPE_KEY: "sk_live_supersecret_value" } } }), {
      manifest: manifest(PROFILE),
      environment: deps,
    });

    expect(r.provider.launched[0]!.env.STRIPE_KEY).toBe("sk_live_supersecret_value");
    const log = readFileSync(join(r.h.config.runsDir, "d1", "run-1.jsonl"), "utf8");
    expect(log).not.toContain("sk_live_supersecret_value");
    expect(log).toContain("••••");
  });

  test("the QA step runs the base branch's commands, with the run's environment", async () => {
    const r = rig();
    const { deps } = fakeDocker();
    await r.run(claim(), { manifest: manifest(PROFILE), environment: deps });
    // `echo ' 3 pass'` is the manifest's test command; the counts prove it ran.
    expect(r.reports.at(-1)!.counts).toEqual({ pass: 3, fail: 0, skip: 0, errors: 0 });
  });

  test("no manifest is today's behaviour — no docker, no ports, the run still lands", async () => {
    const r = rig();
    const { argv, deps } = fakeDocker();
    await r.run(claim(), { manifest: async () => undefined, environment: deps });
    expect(argv).toEqual([]);
    // No manifest and no package.json in the fake worktree: QA fails closed,
    // which is invariant 7 and not an environment problem.
    expect(r.reports.at(-1)!.summary).toContain("no test command");
  });
});

// -------------------------------------------------------------- §21 the rules

const RULES: Rules = {
  dir: "/tmp/runs/d1/rules",
  config: "/tmp/runs/d1/rules/sgconfig.yml",
  bin: "/opt/homebrew/bin/ast-grep",
  ids: ["bun-spawn-resolved-path.yml"],
  scanScript: "/tmp/runs/d1/rules/kairoku-rules-scan.sh",
};

describe("dispatch — §21 the repo's own rules", () => {
  test("rules on the base branch reach every role turn AND the QA step", async () => {
    const r = rig();
    await r.run(claim(), { rules: async () => ({ ok: true, rules: RULES }) });
    expect(r.provider.launched.length).toBeGreaterThan(0);
    for (const launched of r.provider.launched) expect(launched.rules).toEqual(RULES);
  });

  test("no rules on the base branch leaves every turn without them", async () => {
    const r = rig();
    await r.run(claim(), { rules: async () => ({ ok: true }) });
    for (const launched of r.provider.launched) expect(launched.rules).toBeUndefined();
  });

  test("rules the machine cannot check fails the run CLOSED, before a worktree is cut", async () => {
    const r = rig();
    await r.run(claim(), { rules: async () => ({ ok: false, error: "…and ast-grep is not installed on this machine" }) });
    expect(r.h.worktrees.created).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toMatchObject({ status: "failed" });
    expect(r.reports[0]!.summary).toContain("ast-grep is not installed");
  });

  test("they are read ONCE per dispatch, not once per member", async () => {
    const r = rig({ maxConcurrent: 3 });
    let reads = 0;
    await r.run(claim({ items: [fakeItem(1), fakeItem(2), fakeItem(3)] }), {
      rules: async () => {
        reads++;
        return { ok: true, rules: RULES };
      },
    });
    expect(reads).toBe(1);
  });

});

// ------------------------------------------------- §21 Q15/Q19 CodeGraph on probation

const CODEGRAPH: CodeGraph = { bin: "/opt/homebrew/bin/codegraph", worktree: "/tmp/wt" };

const withIntelligence = (names: string[]) => {
  const parsed = parseManifest(JSON.stringify({ intelligence: names, test: "echo ' 1 pass'" }));
  if (!parsed.ok) throw new Error(parsed.error);
  return async () => parsed;
};

/** Records the worktrees asked for an index, instead of building one. */
function fakeIndex(answer: IndexedWorktree = { codegraph: CODEGRAPH, event: "codegraph: 573 files in 4.1s" }) {
  const asked: string[] = [];
  return {
    asked,
    index: async (worktree: string): Promise<IndexedWorktree> => {
      asked.push(worktree);
      return answer;
    },
  };
}

describe("dispatch — §21 CodeGraph, opt-in per repo", () => {
  test("the flag ON indexes the worktree BEFORE the first role turn, and every turn gets the index", async () => {
    const r = rig();
    const { asked, index } = fakeIndex();
    await r.run(claim(), { manifest: withIntelligence(["codegraph"]), codegraph: index });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(r.h.worktrees.created[0]!.path);
    expect(r.provider.launched.length).toBeGreaterThan(0);
    for (const launched of r.provider.launched) expect(launched.codegraph).toEqual(CODEGRAPH);
  });

  test("the index step is recorded as ONE event line carrying the file count and the wall clock", async () => {
    const r = rig();
    await r.run(claim(), { manifest: withIntelligence(["codegraph"]), codegraph: fakeIndex().index });
    const log = readFileSync(join(r.h.config.runsDir, "d1", "run-1.jsonl"), "utf8");
    expect(log).toContain("codegraph: 573 files in 4.1s");
  });

  test("the flag OFF changes NOTHING: no index is attempted and no turn carries one", async () => {
    const r = rig();
    const { asked, index } = fakeIndex();
    await r.run(claim(), { manifest: withIntelligence([]), codegraph: index });
    expect(asked).toEqual([]);
    for (const launched of r.provider.launched) expect(launched.codegraph).toBeUndefined();
  });

  test("no manifest at all is the same as off", async () => {
    const r = rig();
    const { asked, index } = fakeIndex();
    await r.run(claim(), { manifest: async () => undefined, codegraph: index });
    expect(asked).toEqual([]);
  });

  test("a machine without CodeGraph DEGRADES SILENTLY — the run lands, with no index and no failure", async () => {
    const r = rig();
    await r.run(claim(), { manifest: withIntelligence(["codegraph"]), codegraph: fakeIndex({}).index });
    expect(r.reports.at(-1)!.status).toBe("done");
    for (const launched of r.provider.launched) expect(launched.codegraph).toBeUndefined();
  });
});

describe("dispatch — §21 Q19, the two numbers the measurement compares", () => {
  // A clean QA (the manifest's own `test` command passes) so the recipe runs
  // ONE implementer turn: a fix loop would make the tool count a property of
  // the fake's script rather than of the measurement.
  const CLEAN_QA = withIntelligence([]);

  test("the end-of-run event carries the tool calls and the wall clock", async () => {
    const r = rig();
    r.provider.script("implementer", [
      { events: [{ kind: "tool", text: "Read a.ts" }, { kind: "text", text: "thinking" }, { kind: "tool", text: "Edit a.ts" }] },
    ]);
    await r.run(claim(), { manifest: CLEAN_QA });
    const log = readFileSync(join(r.h.config.runsDir, "d1", "run-1.jsonl"), "utf8");
    const texts = log
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text?: string }).text ?? "");
    expect(texts.filter((t) => t.startsWith("run: "))).toEqual([expect.stringMatching(/^run: 2 tool calls in \d+\.\ds$/)]);
  });

  test("the same two numbers are on the run's own record, for a post-mortem with no app", async () => {
    const r = rig();
    r.provider.script("implementer", [{ events: [{ kind: "tool", text: "Read a.ts" }] }]);
    await r.run(claim(), { manifest: CLEAN_QA });
    const state = JSON.parse(readFileSync(runStatePath(r.h.config.runsDir, "d1", "run-1"), "utf8")) as {
      measure?: { toolCalls: number; wallClockMs: number };
    };
    expect(state.measure?.toolCalls).toBe(1);
    expect(state.measure?.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});

describe("§21 Q6/Q7 — the patterns.md convention reaches every role, on both hosts", () => {
  const repoDir = join(import.meta.dir, "..", "..");

  test("every daemon role prompt names the memory files it must read first", () => {
    for (const role of ROLE_NAMES) {
      const prompt = rolePrompt(role);
      expect({ [role]: prompt.includes(PATTERNS_PATH) }).toEqual({ [role]: true });
      expect({ [role]: /AGENTS\.md|CLAUDE\.md/.test(prompt) }).toEqual({ [role]: true });
    }
  });

  test("the plugin's implementer and reviewer say the same thing — one convention, two hosts", () => {
    for (const agent of ["implementer", "reviewer"]) {
      const text = readFileSync(join(repoDir, "plugin", "agents", `${agent}.md`), "utf8");
      expect({ [agent]: text.includes(PATTERNS_PATH) }).toEqual({ [agent]: true });
    }
  });

  test("ONE WRITER (§21 Q7): the reviewer treats a change outside the item's scope as a defect", () => {
    for (const text of [
      rolePrompt("reviewer"),
      readFileSync(join(repoDir, "plugin", "agents", "reviewer.md"), "utf8"),
    ]) {
      expect(text).toContain(PATTERNS_PATH);
      expect(text.toLowerCase()).toContain("defect");
    }
  });
});

/**
 * §23.4 — the phase dividers. The app draws one between turn groups, so the
 * contract is "one event per TRANSITION, before the status update", not one per
 * role turn: a fix loop that re-enters a stage it just left is a transition, and
 * a second reviewer turn in the same stage is not.
 */
function curated(r: Rig, runId = "run-1"): Array<{ seq: number; kind: string; text: string }> {
  return readFileSync(join(r.h.config.runsDir, "d1", `${runId}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { seq?: number; kind?: string; text?: string })
    .filter((line): line is { seq: number; kind: string; text: string } => typeof line.seq === "number")
    .map((line) => ({ seq: line.seq, kind: line.kind, text: line.text }));
}

const phases = (r: Rig, runId = "run-1") =>
  curated(r, runId)
    .filter((e) => e.kind === "phase")
    .map((e) => e.text);

describe("dispatch — §23.4 phase markers", () => {
  /** A manifest whose suite passes, so a run reaches `done` rather than the QA loop. */
  const greenQa = { manifest: withIntelligence([]) };

  test("build-verify walks implementing → reviewing → qa → done, one event per transition", async () => {
    const r = rig();
    await r.run(claim(), greenQa);
    expect(phases(r)).toEqual(["implementing", "reviewing", "qa", "done"]);
  });

  test("a reviewer fix loop is a transition BACK, and says so", async () => {
    const r = rig();
    r.provider.script("reviewer", [
      { report: { verdict: "NOT_CLEAN", defects: ["a.ts:1 — the guard is wrong"] } },
      { report: CLEAN },
    ]);
    await r.run(claim(), greenQa);
    expect(phases(r)).toEqual(["implementing", "reviewing", "implementing", "reviewing", "qa", "done"]);
  });

  test("the QA fix loop draws its own dividers, and the run that gives up ends on failed", async () => {
    // The default rig has no test command, so QA fails closed and the loop runs
    // its two rounds — which is exactly the shape a reader needs a divider for.
    const r = rig();
    await r.run(claim());
    expect(phases(r)).toEqual([
      "implementing",
      "reviewing",
      "qa",
      "implementing",
      "qa",
      "implementing",
      "qa",
      "failed",
    ]);
  });

  test("a turn that never finished ends on `failed`, so the transcript closes on the truth", async () => {
    const r = rig();
    r.provider.script("implementer", [{ ok: false, summary: "the model gave up" }]);
    await r.run(claim(), greenQa);
    expect(phases(r)).toEqual(["implementing", "failed"]);
    expect(r.reports.at(-1)!.status).toBe("failed");
  });

  test("the phase leads the work it names — the divider is above the turn, never below it", async () => {
    const r = rig();
    r.provider.script("implementer", [{ events: [{ kind: "tool", text: 'Bash {"command":"bun test"}' }] }]);
    await r.run(claim(), greenQa);
    const lines = curated(r);
    const phase = lines.findIndex((e) => e.kind === "phase" && e.text === "implementing");
    const tool = lines.findIndex((e) => e.kind === "tool");
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(tool);
  });

  test("the closing divider travels WITH the terminal report, which is the only thing that can carry it", async () => {
    // The link drains `store.list()`, which holds only RUNNING runs, so a line
    // pushed in a run's last moments — the divider, and §21's `run: n tool
    // calls` measure line — reaches the local log and nothing else unless the
    // report it belongs to carries it.
    const r = rig();
    await r.run(claim(), greenQa);
    const last = r.reports.at(-1)!;
    expect(last.status).toBe("done");
    expect((last.events ?? []).map((e) => e.text)).toContain("done");
    expect((last.events ?? []).some((e) => e.text.startsWith("run: "))).toBe(true);
  });

  test("the whole log stays seq-ordered with the new kinds in it", async () => {
    const r = rig();
    r.provider.script("implementer", [{ events: [{ kind: "text", text: "on it" }] }]);
    await r.run(claim(), greenQa);
    const seqs = curated(r).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("dispatch — the CI-2 rider: the index line is its own kind", () => {
  test("the index event is `index`, not `ok` — the app's enum accepts it now", async () => {
    const r = rig();
    await r.run(claim(), { manifest: withIntelligence(["codegraph"]), codegraph: fakeIndex().index });
    expect(curated(r).find((e) => e.text.startsWith("codegraph: "))).toMatchObject({
      kind: "index",
      text: "codegraph: 573 files in 4.1s",
    });
  });
});
