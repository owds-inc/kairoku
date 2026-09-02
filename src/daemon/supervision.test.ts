/**
 * The five supervision tests the SPEC's v0 exit criterion names by hand:
 * orphan reaping on cancel, teardown on timeout, teardown on daemon SIGTERM,
 * refusal of a duplicate credential, refusal past capacity.
 *
 * No real `codex`, no network. Agent commands are stubbed through
 * Config.commandOverride (RF-009's test-only config).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "./runs";
import { eventsPath } from "./events";
import { groupAlive } from "./proc";
import { harness, runRequest, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function events(h: Harness, runId: string): Array<Record<string, unknown>> {
  const path = eventsPath(h.config.runsDir, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervision", () => {
  test("cancel reaps orphans: a grandchild of the agent dies with the group", async () => {
    // The stub agent backgrounds a grandchild and records its pid. Killing only
    // the direct child would leave that grandchild running — the exact leak
    // RF-010's process-group kill exists to prevent.
    const h = (active = harness({
      commandOverride: (spec) => [
        "sh",
        "-c",
        `sleep 30 & echo $! > ${spec.cwd}/grandchild.pid; sleep 30`,
      ],
    }));
    const store = new RunStore(h.config);

    const created = store.create(runRequest("pat-orphan"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runId = created.runId;

    const worktree = join(h.config.worktreesDir, runId);
    const pidFile = join(worktree, "grandchild.pid");
    await waitFor(() => existsSync(pidFile), "grandchild to record its pid");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    expect(store.cancel(runId)).toBe(true);

    await waitFor(
      () => store.view(runId)?.status !== "running",
      "run to reach a terminal status",
    );
    await waitFor(() => !alive(grandchild), "orphaned grandchild to be reaped");

    expect(store.view(runId)?.status).toBe("error");
    expect(store.view(runId)?.exitSummary).toBe("cancelled");
    // And teardown still ran on this exit path.
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  test("timeout kills the agent, marks `timeout`, and tears the worktree down", async () => {
    const h = (active = harness({
      commandOverride: () => ["sh", "-c", "sleep 30"],
    }));
    const store = new RunStore(h.config);

    const created = store.create(
      runRequest("pat-timeout", { timeoutSec: 0.5 }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runId = created.runId;

    await waitFor(
      () => store.view(runId)?.status === "timeout",
      "run to time out",
    );

    const view = store.view(runId)!;
    expect(view.status).toBe("timeout");
    expect(view.exitSummary).toBe("timeout after 0.5s");

    const worktree = join(h.config.worktreesDir, runId);
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);

    const kinds = events(h, runId).map((e) => e.type);
    expect(kinds).toContain("created");
    expect(kinds).toContain("started");
    expect(kinds).toContain("teardown");
    expect(kinds).toContain("finished");
  });

  test("daemon SIGTERM kills children, marks runs, and tears worktrees down", async () => {
    // store.shutdown() is exactly what the SIGTERM handler in server.ts calls;
    // a separate test proves that handler is wired to a real signal.
    const h = (active = harness({
      commandOverride: () => ["sh", "-c", "sleep 30"],
    }));
    const store = new RunStore(h.config);

    const a = store.create(runRequest("pat-shutdown-a"));
    const b = store.create(runRequest("pat-shutdown-b"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await waitFor(
      () => h.worktrees.created.length === 2,
      "both worktrees to be set up",
    );

    await store.shutdown();

    for (const runId of [a.runId, b.runId]) {
      const view = store.view(runId)!;
      expect(view.status).toBe("error");
      expect(view.exitSummary).toBe("daemon-shutdown");
      const worktree = join(h.config.worktreesDir, runId);
      expect(existsSync(worktree)).toBe(false);
      expect(events(h, runId).map((e) => e.type)).toContain("finished");
    }
    expect(h.worktrees.removed).toHaveLength(2);
    expect(store.capacity().running).toBe(0);
  });

  test("refuses a duplicate credential (RF-008), by hash, without logging it", async () => {
    const h = (active = harness({
      commandOverride: () => ["sh", "-c", "sleep 30"],
    }));
    const store = new RunStore(h.config);

    const first = store.create(runRequest("shared-secret-value"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = store.create(runRequest("shared-secret-value"));
    expect(second).toEqual({ ok: false, reason: "duplicate_credential" });

    // A different credential in the same slot is fine.
    const third = store.create(runRequest("a-different-secret"));
    expect(third.ok).toBe(true);

    // RF-008: the value never appears in the event log.
    const log = readFileSync(
      eventsPath(h.config.runsDir, first.runId),
      "utf8",
    );
    expect(log).not.toContain("shared-secret-value");

    await store.shutdown();

    // Once the holder is no longer running, the credential frees up.
    const fourth = store.create(runRequest("shared-secret-value"));
    expect(fourth.ok).toBe(true);
    await store.shutdown();
  });

  test("refuses past capacity (RF-005) rather than queueing", async () => {
    const h = (active = harness({
      maxConcurrent: 2,
      commandOverride: () => ["sh", "-c", "sleep 30"],
    }));
    const store = new RunStore(h.config);

    expect(store.create(runRequest("pat-cap-1")).ok).toBe(true);
    expect(store.create(runRequest("pat-cap-2")).ok).toBe(true);
    expect(store.capacity()).toEqual({ running: 2, max: 2 });

    const overflow = store.create(runRequest("pat-cap-3"));
    expect(overflow).toEqual({ ok: false, reason: "capacity_full" });

    // Refusal, not a queue: no third run exists anywhere.
    expect(store.capacity().running).toBe(2);
    expect(h.worktrees.created.length).toBeLessThanOrEqual(2);

    await store.shutdown();
    expect(store.capacity()).toEqual({ running: 0, max: 2 });

    // Capacity is reusable once a slot frees.
    expect(store.create(runRequest("pat-cap-4")).ok).toBe(true);
    await store.shutdown();
  });
});
