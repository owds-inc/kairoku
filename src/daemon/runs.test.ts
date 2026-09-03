/**
 * Run lifecycle (RF-005, RF-010).
 *
 * A run is a MEMBER OF A TEAM now, not a process: `start()` takes a body and
 * runs it in a fresh worktree. What the body does is `recipes.ts`'s business —
 * these tests use the smallest possible one, a shell command, so that what is
 * under test is the store's own four jobs: capacity, worktree, teardown on
 * every path, and a cancel that reaches whatever is running.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsPath, stdoutPath } from "./events";
import { RunStore, type ExecContext } from "./runs";
import { harness, stubExec, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function eventTypes(h: Harness, dispatchId: string, runId = dispatchId): string[] {
  const path = eventsPath(h.config.runsDir, dispatchId, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).type as string)
    .filter(Boolean);
}

const spec = (
  id: string,
  execute: (ctx: ExecContext) => Promise<{ ok: boolean; summary: string }>,
  extra: Record<string, unknown> = {},
) => ({ dispatchId: id, runId: id, name: id, execute, ...extra });

const shell = (h: Harness, id: string, command: string, options: Record<string, unknown> = {}) =>
  stubExec(["sh", "-c", command], {
    stdoutPath: () => stdoutPath(h.config.runsDir, id, id),
    ...options,
  });

describe("runs — lifecycle (RF-010)", () => {
  test("a clean exit is `idle`, and the worktree is torn down", async () => {
    const h = (active = harness());
    const result = await new RunStore(h.config).start(spec("r-ok", shell(h, "r-ok", "exit 0")));
    expect(result.status).toBe("idle");
    expect(result.branch).toBe("run/r-ok");
    expect(h.worktrees.removed).toHaveLength(1);
    expect(eventTypes(h, "r-ok")).toEqual(["created", "started", "teardown", "finished"]);
  });

  test("a body that says it failed is `error` with its own summary", async () => {
    const h = (active = harness());
    const result = await new RunStore(h.config).start(spec("r-fail", shell(h, "r-fail", "exit 3")));
    expect(result).toMatchObject({ status: "error", exitSummary: "exit 3" });
  });

  test("a body that throws fails the run rather than the daemon", async () => {
    const h = (active = harness());
    const result = await new RunStore(h.config).start(
      spec("r-throw", async () => {
        throw new Error("the recipe exploded");
      }),
    );
    expect(result).toMatchObject({ status: "error", exitSummary: "the run threw: the recipe exploded" });
    expect(h.worktrees.removed).toHaveLength(1);
  });

  test("a worktree that cannot be set up fails the run and starts no body", async () => {
    const h = (active = harness());
    h.worktrees.failNext = true;
    let ran = false;
    const result = await new RunStore(h.config).start(
      spec("r-wt", async () => {
        ran = true;
        return { ok: true, summary: "" };
      }),
    );
    expect(result).toMatchObject({ status: "error", exitSummary: "worktree-setup-failed: fetch refused" });
    expect(ran).toBe(false);
    expect(eventTypes(h, "r-wt")).toEqual(["created", "finished"]);
    expect(h.worktrees.removed).toHaveLength(0);
  });

  test("a cancel landing during setup never starts the body", async () => {
    const h = (active = harness());
    h.worktrees.delayMs = 120;
    const store = new RunStore(h.config);
    let ran = false;
    const running = store.start(
      spec("r-race", async () => {
        ran = true;
        return { ok: true, summary: "" };
      }),
    );
    // DURING setup, not before it: a cancel that lands while the member is still
    // queued is answered earlier (no worktree is ever cut), which is the case
    // the capacity gate's own tests cover.
    await Bun.sleep(20);
    expect(store.cancel("r-race")).toBe(true);
    expect(await running).toMatchObject({ status: "error", exitSummary: "cancelled by the app" });
    expect(ran).toBe(false);
    expect(eventTypes(h, "r-race")).not.toContain("started");
    expect(h.worktrees.removed).toHaveLength(1);
  });

  test("a cancel mid-run reaches the attached handle and outranks the body's own answer", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const running = store.start(spec("r-mid", shell(h, "r-mid", "sleep 30")));
    await waitFor(() => h.worktrees.created.length === 1, "the worktree");
    await waitFor(() => store.list().length === 1, "the run to be listed");
    await Bun.sleep(50);
    expect(store.cancel("r-mid")).toBe(true);
    expect(await running).toMatchObject({ status: "error", exitSummary: "cancelled by the app" });
  });

  test("cancelling a whole dispatch stops every member of it and nobody else's", async () => {
    const h = (active = harness({ maxConcurrent: 4 }));
    const store = new RunStore(h.config);
    const a = store.start({ ...spec("m1", shell(h, "d1", "sleep 30")), dispatchId: "d1", runId: "m1" });
    const b = store.start({ ...spec("m2", shell(h, "d1", "sleep 30")), dispatchId: "d1", runId: "m2" });
    const c = store.start({ ...spec("m3", shell(h, "d2", "sleep 30")), dispatchId: "d2", runId: "m3" });
    await waitFor(() => store.list().length === 3, "three members");

    expect(store.cancelDispatch("d1")).toBe(2);
    expect((await a).exitSummary).toBe("cancelled by the app");
    expect((await b).exitSummary).toBe("cancelled by the app");
    expect(store.list().map((r) => r.runId)).toEqual(["m3"]);
    await store.shutdown();
    await c;
  });

  test("the per-run time limit stops a run that will not stop itself (§20 item 8)", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const result = await store.start({
      ...spec("r-slow", shell(h, "r-slow", "sleep 30")),
      timeoutSec: 0.2,
    });
    expect(result.status).toBe("timeout");
    expect(result.exitSummary).toContain("time limit");
  });

  test("cancel is false for an unknown run and for a settled one", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    expect(store.cancel("nope")).toBe(false);
    await store.start(spec("r-done", shell(h, "r-done", "exit 0")));
    expect(store.cancel("r-done")).toBe(false);
  });

  test("keepWorktreeOnFailure keeps a failed run's tree but not a clean one's", async () => {
    const failed = (active = harness({ keepWorktreeOnFailure: true }));
    await new RunStore(failed.config).start(spec("r-keep", shell(failed, "r-keep", "exit 9")));
    expect(failed.worktrees.removed).toHaveLength(0);
    expect(existsSync(join(failed.config.worktreesDir, "r-keep"))).toBe(true);
    failed.cleanup();

    const clean = (active = harness({ keepWorktreeOnFailure: true }));
    await new RunStore(clean.config).start(spec("r-clean", shell(clean, "r-clean", "exit 0")));
    expect(clean.worktrees.removed).toHaveLength(1);
  });

  test("the brief reaches the agent on stdin, verbatim", async () => {
    const h = (active = harness());
    const brief = "- a brief that starts with a dash\nand has two lines";
    await new RunStore(h.config).start(spec("r-brief", shell(h, "r-brief", "cat", { stdin: brief })));
    expect(readFileSync(stdoutPath(h.config.runsDir, "r-brief", "r-brief"), "utf8")).toBe(brief);
  });

  test("injected env reaches the agent; no credential of the daemon's own does", async () => {
    const before = {
      KAIROKU_DAEMON_TOKEN: process.env.KAIROKU_DAEMON_TOKEN,
      HIKYAKU_TOKEN: process.env.HIKYAKU_TOKEN,
      KAIROKU_AGENT_TOKEN: process.env.KAIROKU_AGENT_TOKEN,
    };
    process.env.KAIROKU_DAEMON_TOKEN = "app-credential-must-not-leak";
    process.env.HIKYAKU_TOKEN = "legacy-credential-must-not-leak";
    process.env.KAIROKU_AGENT_TOKEN = "fallback-must-not-leak";
    try {
      const h = (active = harness());
      await new RunStore(h.config).start(
        spec(
          "r-env",
          shell(
            h,
            "r-env",
            'echo "pat=$KAIROKU_PAT extra=$EXTRA leaked=[$KAIROKU_DAEMON_TOKEN$HIKYAKU_TOKEN$KAIROKU_AGENT_TOKEN]"',
            { env: { KAIROKU_PAT: "the-run-pat", EXTRA: "yes" } },
          ),
        ),
      );

      const out = readFileSync(stdoutPath(h.config.runsDir, "r-env", "r-env"), "utf8");
      expect(out).toContain("pat=the-run-pat");
      expect(out).toContain("extra=yes");
      // An agent gets exactly the one PAT its run was given (RF-007 amended).
      expect(out).toContain("leaked=[]");
      expect(out).not.toContain("must-not-leak");
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the in-flight listing carries no credential, names the role and state, and drops a settled run", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const running = store.start({
      ...spec("r-list", shell(h, "r-list", "sleep 30", { env: { KAIROKU_PAT: "a-very-secret-pat" } })),
      role: "implementer" as const,
      secrets: ["a-very-secret-pat"],
    });

    await waitFor(() => store.list()[0]?.state === "running", "the run to be running");
    expect(store.list()).toEqual([
      {
        dispatchId: "r-list",
        runId: "r-list",
        role: "implementer",
        state: "running",
        status: "running",
        startedAt: expect.any(String),
        branch: "run/r-list",
      },
    ]);
    expect(JSON.stringify(store.list())).not.toContain("a-very-secret-pat");

    await store.shutdown();
    await running;
    expect(store.list()).toEqual([]);
  });

  test("curated events are buffered per run and drained by whoever reports them", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.start(
      spec("r-ev", async (ctx) => {
        ctx.events.push("text", "reading the item");
        ctx.events.push("deny", "the reviewer may not use Write");
        return { ok: true, summary: "done" };
      }),
    );
    const drained = store.drainEvents("r-ev");
    expect(drained.map((e) => e.kind)).toEqual(["text", "deny"]);
    expect(store.drainEvents("r-ev")).toEqual([]);
    expect(store.drainEvents("no-such-run")).toEqual([]);
  });

  test("a delivered value never reaches the curated channel or the log", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.start({
      ...spec("r-mask", async (ctx) => {
        ctx.events.push("tool", "Bash {\"command\":\"echo kai_run_token_9\"}");
        return { ok: true, summary: "done" };
      }),
      secrets: ["kai_run_token_9"],
    });
    expect(JSON.stringify(store.drainEvents("r-mask"))).not.toContain("kai_run_token_9");
    expect(readFileSync(eventsPath(h.config.runsDir, "r-mask", "r-mask"), "utf8")).not.toContain("kai_run_token_9");
  });

  test("branches are distinct across concurrent members, and capacity counts them", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const a = store.start(spec("r-a", shell(h, "r-a", "sleep 30")));
    const b = store.start(spec("r-b", shell(h, "r-b", "sleep 30")));
    expect(store.capacity()).toEqual({ running: 2, max: 2 });
    expect(store.free()).toBe(0);
    expect(store.list().map((r) => r.branch).sort()).toEqual(["run/r-a", "run/r-b"]);

    await waitFor(() => h.worktrees.created.length === 2, "both worktrees");
    await store.shutdown();
    await Promise.all([a, b]);
    expect(store.free()).toBe(2);
  });

  test("capacity is a GATE, not a hint: a third member waits for a slot", async () => {
    // Two dispatches can overlap — the claim loop refuses only when nothing is
    // free — so the fan-out's own bound cannot be the enforcement. This is the
    // one place that counts.
    const h = (active = harness());
    const store = new RunStore(h.config);
    let live = 0;
    let peak = 0;
    const body = async () => {
      live++;
      peak = Math.max(peak, live);
      await Bun.sleep(30);
      live--;
      return { ok: true, summary: "done" };
    };

    const all = ["r-1", "r-2", "r-3"].map((id) => store.start(spec(id, body)));
    // The queued member is not "running": the beat and the claim loop both read
    // this number, and a queued member counted as running would refuse work the
    // machine can take.
    expect(store.capacity()).toEqual({ running: 2, max: 2 });

    const results = await Promise.all(all);
    expect(results.map((r) => r.status)).toEqual(["idle", "idle", "idle"]);
    expect(peak).toBe(2);
    expect(h.worktrees.created).toHaveLength(3);
    expect(store.free()).toBe(2);
  });

  test("shutdown does not deadlock on a member still waiting for a slot", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const all = ["s-1", "s-2", "s-3"].map((id) => store.start(spec(id, shell(h, id, "sleep 30"))));
    await waitFor(() => h.worktrees.created.length === 2, "the two that fit");
    await store.shutdown();
    const results = await Promise.all(all);
    expect(results.every((r) => r.status === "error")).toBe(true);
    // The queued one never got a worktree, so there was never one to tear down.
    expect(h.worktrees.created).toHaveLength(2);
  });

  test("a member's worktree name is what names its branch, not its run id", async () => {
    // A phase team's members share a dispatch and each get `run/<dispatch>-<n>`.
    const h = (active = harness());
    const store = new RunStore(h.config);
    const result = await store.start({
      dispatchId: "d9",
      runId: "run-uuid-2",
      name: "d9-2",
      execute: shell(h, "d9", "exit 0"),
    });
    expect(result.branch).toBe("run/d9-2");
  });

  test("shutdown is idempotent and safe with no runs", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.shutdown();
    await store.shutdown();
    expect(store.capacity()).toEqual({ running: 0, max: 2 });
  });
});
