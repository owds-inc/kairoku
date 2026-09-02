import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsPath, stdoutPath } from "./events";
import { hashCredential, REFUSAL_REASONS, RunStore } from "./runs";
import { harness, runRequest, waitFor, type Harness } from "./testkit";

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

async function settled(store: RunStore, runId: string) {
  await waitFor(
    () => store.view(runId)?.status !== "running",
    `run ${runId} to settle`,
  );
  return store.view(runId)!;
}

describe("runs — the refusal set (RF-001)", () => {
  test("the vocabulary is exactly the five named reasons", () => {
    expect([...REFUSAL_REASONS].sort()).toEqual([
      "capacity_full",
      "duplicate_credential",
      "empty_brief",
      "missing_credential",
      "unknown_role",
    ]);
  });

  test("empty_brief covers absent, blank and whitespace-only briefs", () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    for (const brief of [undefined, "", "   ", "\n\t "]) {
      expect(store.create({ ...runRequest("p"), brief })).toEqual({
        ok: false,
        reason: "empty_brief",
      });
    }
  });

  test("unknown_role covers an absent role and one not in the table", () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    expect(store.create({ ...runRequest("p"), role: undefined })).toEqual({
      ok: false,
      reason: "unknown_role",
    });
    expect(store.create({ ...runRequest("p"), role: "reviewer" })).toEqual({
      ok: false,
      reason: "unknown_role",
    });
  });

  test("missing_credential covers absent env, absent PAT and a blank PAT", () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    const refusal = { ok: false, reason: "missing_credential" } as const;
    expect(store.create({ ...runRequest("p"), env: undefined })).toEqual(refusal);
    expect(store.create({ ...runRequest("p"), env: {} })).toEqual(refusal);
    expect(
      store.create({ ...runRequest("p"), env: { KAIROKU_PAT: "  " } }),
    ).toEqual(refusal);
  });

  test("a refusal starts nothing: no worktree, no run, no event log", () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    store.create({ ...runRequest("p"), brief: "" });
    expect(h.worktrees.created).toHaveLength(0);
    expect(store.capacity().running).toBe(0);
  });

  test("credential hashing is stable and value-distinguishing", () => {
    expect(hashCredential("a")).toBe(hashCredential("a"));
    expect(hashCredential("a")).not.toBe(hashCredential("b"));
    expect(hashCredential("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runs — lifecycle (RF-002, RF-010)", () => {
  test("a clean exit is `idle`, and the worktree is torn down", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    const created = store.create(runRequest("pat-ok"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const view = await settled(store, created.runId);
    expect(view.status).toBe("idle");
    expect(view.exitSummary).toBe("exit 0");
    expect(view.branch).toBe(`run/${created.runId}`);
    expect(Date.parse(view.startedAt)).not.toBeNaN();
    expect(h.worktrees.removed).toHaveLength(1);
    expect(eventTypes(h, created.runId)).toEqual([
      "created",
      "started",
      "teardown",
      "finished",
    ]);
  });

  test("a non-zero exit is `error` with its code", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 3"] }));
    const store = new RunStore(h.config);
    const created = store.create(runRequest("pat-fail"));
    if (!created.ok) throw new Error("expected creation");
    const view = await settled(store, created.runId);
    expect(view.status).toBe("error");
    expect(view.exitSummary).toBe("exit 3");
  });

  test("`blocked` is never emitted — v0 cannot reach it", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 1"] }));
    const store = new RunStore(h.config);
    const created = store.create(runRequest("pat-nb"));
    if (!created.ok) throw new Error("expected creation");
    const view = await settled(store, created.runId);
    expect(["running", "idle", "error", "timeout"]).toContain(view.status);
  });

  test("a worktree that cannot be set up fails the run and starts no agent", async () => {
    const h = (active = harness());
    h.worktrees.failNext = true;
    const store = new RunStore(h.config);
    const created = store.create(runRequest("pat-wt"));
    if (!created.ok) throw new Error("expected creation");

    const view = await settled(store, created.runId);
    expect(view.status).toBe("error");
    expect(view.exitSummary).toBe("worktree-setup-failed: fetch refused");
    expect(eventTypes(h, created.runId)).toEqual(["created", "finished"]);
    expect(h.worktrees.removed).toHaveLength(0);
  });

  test("a cancel landing during setup never starts the agent", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    h.worktrees.delayMs = 120;
    const store = new RunStore(h.config);
    const created = store.create(runRequest("pat-race"));
    if (!created.ok) throw new Error("expected creation");

    expect(store.cancel(created.runId)).toBe(true);
    const view = await settled(store, created.runId);
    expect(view.status).toBe("error");
    expect(view.exitSummary).toBe("cancelled");
    // No agent was ever launched, but the worktree still got torn down.
    expect(eventTypes(h, created.runId)).not.toContain("started");
    expect(h.worktrees.removed).toHaveLength(1);
  });

  test("cancel is false for an unknown run and for a settled one", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    expect(store.cancel("nope")).toBe(false);
    expect(store.view("nope")).toBeUndefined();

    const created = store.create(runRequest("pat-done"));
    if (!created.ok) throw new Error("expected creation");
    await settled(store, created.runId);
    expect(store.cancel(created.runId)).toBe(false);
  });

  test("keepWorktreeOnFailure keeps a failed run's tree but not a clean one's", async () => {
    const failed = (active = harness({
      keepWorktreeOnFailure: true,
      commandOverride: () => ["sh", "-c", "exit 9"],
    }));
    const failStore = new RunStore(failed.config);
    const bad = failStore.create(runRequest("pat-keep"));
    if (!bad.ok) throw new Error("expected creation");
    await settled(failStore, bad.runId);
    expect(failed.worktrees.removed).toHaveLength(0);
    expect(existsSync(join(failed.config.worktreesDir, bad.runId))).toBe(true);
    failed.cleanup();

    const clean = (active = harness({
      keepWorktreeOnFailure: true,
      commandOverride: () => ["sh", "-c", "exit 0"],
    }));
    const cleanStore = new RunStore(clean.config);
    const good = cleanStore.create(runRequest("pat-keep"));
    if (!good.ok) throw new Error("expected creation");
    await settled(cleanStore, good.runId);
    expect(clean.worktrees.removed).toHaveLength(1);
  });

  test("the brief reaches the agent on stdin, verbatim", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "cat"] }));
    const store = new RunStore(h.config);
    const brief = "- a brief that starts with a dash\nand has two lines";
    const created = store.create({ ...runRequest("pat-brief"), brief });
    if (!created.ok) throw new Error("expected creation");
    await settled(store, created.runId);
    expect(readFileSync(stdoutPath(h.config.runsDir, created.runId), "utf8")).toBe(
      brief,
    );
  });

  test("injected env reaches the agent; the daemon's own bearer does not", async () => {
    const previous = process.env.HIKYAKU_TOKEN;
    process.env.HIKYAKU_TOKEN = "daemon-bearer-must-not-leak";
    try {
      const h = (active = harness({
        commandOverride: () => [
          "sh",
          "-c",
          'echo "pat=$KAIROKU_PAT extra=$EXTRA token=[$HIKYAKU_TOKEN]"',
        ],
      }));
      const store = new RunStore(h.config);
      const created = store.create({
        ...runRequest("the-slot-pat"),
        env: { KAIROKU_PAT: "the-slot-pat", EXTRA: "yes" },
      });
      if (!created.ok) throw new Error("expected creation");
      await settled(store, created.runId);

      const out = readFileSync(
        stdoutPath(h.config.runsDir, created.runId),
        "utf8",
      );
      expect(out).toContain("pat=the-slot-pat");
      expect(out).toContain("extra=yes");
      // RF-007: the runner's own credential is not an agent's to hold.
      expect(out).toContain("token=[]");
      expect(out).not.toContain("daemon-bearer-must-not-leak");
    } finally {
      if (previous === undefined) delete process.env.HIKYAKU_TOKEN;
      else process.env.HIKYAKU_TOKEN = previous;
    }
  });

  test("the run view never exposes the credential or its hash", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    const created = store.create(runRequest("a-very-secret-pat"));
    if (!created.ok) throw new Error("expected creation");
    const view = await settled(store, created.runId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("a-very-secret-pat");
    expect(serialized).not.toContain(hashCredential("a-very-secret-pat"));
    expect(Object.keys(view).sort()).toEqual([
      "branch",
      "exitSummary",
      "startedAt",
      "status",
    ]);
  });

  test("run ids and branches are distinct across concurrent runs", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    const a = store.create(runRequest("pat-a"));
    const b = store.create(runRequest("pat-b"));
    if (!a.ok || !b.ok) throw new Error("expected creation");
    expect(a.runId).not.toBe(b.runId);
    await settled(store, a.runId);
    await settled(store, b.runId);
    expect(store.view(a.runId)!.branch).not.toBe(store.view(b.runId)!.branch);
  });

  test("shutdown is idempotent and safe with no runs", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.shutdown();
    await store.shutdown();
    expect(store.capacity()).toEqual({ running: 0, max: 2 });
  });
});
