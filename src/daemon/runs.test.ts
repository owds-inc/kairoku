/**
 * Run lifecycle (RF-005, RF-009, RF-010).
 *
 * The refusal set that used to live here went with the push API it answered
 * (SPEC v1, §20.3): there is no inbound caller left to refuse. What a claim
 * cannot be run for is now REPORTED to the app instead — `dispatch.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsPath, stdoutPath } from "./events";
import { RunStore, SOLO_ROLE } from "./runs";
import { harness, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function eventTypes(h: Harness, runId: string): string[] {
  const path = eventsPath(h.config.runsDir, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).type as string);
}

const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  brief: "build the thing",
  env: { KAIROKU_PAT: `pat-${id}` },
  ...extra,
});

describe("runs — lifecycle (RF-010)", () => {
  test("a clean exit is `idle`, and the worktree is torn down", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);

    const result = await store.start(spec("r-ok"));
    expect(result.status).toBe("idle");
    expect(result.exitSummary).toBe("exit 0");
    expect(result.branch).toBe("run/r-ok");
    expect(h.worktrees.removed).toHaveLength(1);
    expect(eventTypes(h, "r-ok")).toEqual(["created", "started", "teardown", "finished"]);
  });

  test("a non-zero exit is `error` with its code", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 3"] }));
    const result = await new RunStore(h.config).start(spec("r-fail"));
    expect(result).toMatchObject({ status: "error", exitSummary: "exit 3" });
  });

  test("`blocked` is never emitted — nothing can reach it", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 1"] }));
    const result = await new RunStore(h.config).start(spec("r-nb"));
    expect(["running", "idle", "error", "timeout"]).toContain(result.status);
  });

  test("a worktree that cannot be set up fails the run and starts no agent", async () => {
    const h = (active = harness());
    h.worktrees.failNext = true;
    const result = await new RunStore(h.config).start(spec("r-wt"));
    expect(result).toMatchObject({ status: "error", exitSummary: "worktree-setup-failed: fetch refused" });
    expect(eventTypes(h, "r-wt")).toEqual(["created", "finished"]);
    expect(h.worktrees.removed).toHaveLength(0);
  });

  test("a cancel landing during setup never starts the agent", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    h.worktrees.delayMs = 120;
    const store = new RunStore(h.config);

    const running = store.start(spec("r-race"));
    expect(store.cancel("r-race")).toBe(true);
    expect(await running).toMatchObject({ status: "error", exitSummary: "cancelled" });
    // No agent was ever launched, but the worktree still got torn down.
    expect(eventTypes(h, "r-race")).not.toContain("started");
    expect(h.worktrees.removed).toHaveLength(1);
  });

  test("cancel is false for an unknown run and for a settled one", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    expect(store.cancel("nope")).toBe(false);
    await store.start(spec("r-done"));
    expect(store.cancel("r-done")).toBe(false);
  });

  test("keepWorktreeOnFailure keeps a failed run's tree but not a clean one's", async () => {
    const failed = (active = harness({ keepWorktreeOnFailure: true, commandOverride: () => ["sh", "-c", "exit 9"] }));
    await new RunStore(failed.config).start(spec("r-keep"));
    expect(failed.worktrees.removed).toHaveLength(0);
    expect(existsSync(join(failed.config.worktreesDir, "r-keep"))).toBe(true);
    failed.cleanup();

    const clean = (active = harness({ keepWorktreeOnFailure: true, commandOverride: () => ["sh", "-c", "exit 0"] }));
    await new RunStore(clean.config).start(spec("r-clean"));
    expect(clean.worktrees.removed).toHaveLength(1);
  });

  test("the brief reaches the agent on stdin, verbatim", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "cat"] }));
    const brief = "- a brief that starts with a dash\nand has two lines";
    await new RunStore(h.config).start(spec("r-brief", { brief }));
    expect(readFileSync(stdoutPath(h.config.runsDir, "r-brief"), "utf8")).toBe(brief);
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
      const h = (active = harness({
        commandOverride: () => [
          "sh",
          "-c",
          'echo "pat=$KAIROKU_PAT extra=$EXTRA leaked=[$KAIROKU_DAEMON_TOKEN$HIKYAKU_TOKEN$KAIROKU_AGENT_TOKEN]"',
        ],
      }));
      await new RunStore(h.config).start(spec("r-env", { env: { KAIROKU_PAT: "the-run-pat", EXTRA: "yes" } }));

      const out = readFileSync(stdoutPath(h.config.runsDir, "r-env"), "utf8");
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

  test("the in-flight listing carries no credential, and drops a run once it settles", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    const store = new RunStore(h.config);
    const running = store.start(spec("r-list", { env: { KAIROKU_PAT: "a-very-secret-pat" } }));

    expect(store.list()).toEqual([
      { dispatchId: "r-list", status: "running", startedAt: expect.any(String), branch: "run/r-list" },
    ]);
    expect(JSON.stringify(store.list())).not.toContain("a-very-secret-pat");

    await waitFor(() => h.worktrees.created.length === 1, "worktree setup");
    await store.shutdown();
    await running;
    expect(store.list()).toEqual([]);
  });

  test("branches are distinct across concurrent runs, and capacity counts them both", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    const store = new RunStore(h.config);
    const a = store.start(spec("r-a"));
    const b = store.start(spec("r-b"));
    expect(store.capacity()).toEqual({ running: 2, max: 2 });
    expect(store.list().map((r) => r.branch).sort()).toEqual(["run/r-a", "run/r-b"]);

    await waitFor(() => h.worktrees.created.length === 2, "both worktrees");
    await store.shutdown();
    await Promise.all([a, b]);
  });

  test("the role table still has exactly one entry (RF-009)", () => {
    expect(SOLO_ROLE).toBe("executor");
  });

  test("shutdown is idempotent and safe with no runs", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.shutdown();
    await store.shutdown();
    expect(store.capacity()).toEqual({ running: 0, max: 2 });
  });
});
