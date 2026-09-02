/**
 * The supervision cases the SPEC's exit criterion names by hand: orphan reaping
 * on cancel, teardown on timeout, teardown on daemon SIGTERM, and the pin that
 * no credential ever reaches the event log.
 *
 * The two refusal cases that used to live here (duplicate credential, past
 * capacity) went with the push API they answered (SPEC v1, §20.3). Capacity is
 * now a gate on CLAIMING — `link.test.ts` — and credential distinctness moves
 * to issuance when the app mints one token per run (RF-008 amended).
 *
 * No real `codex`, no network. Agent commands are stubbed through
 * Config.commandOverride (RF-009's test-only config).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "./runs";
import { eventsPath } from "./events";
import { harness, waitFor, type Harness } from "./testkit";

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

const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  brief: "build the thing",
  env: { KAIROKU_PAT: `pat-${id}` },
  ...extra,
});

describe("supervision", () => {
  test("cancel reaps orphans: a grandchild of the agent dies with the group", async () => {
    // The stub agent backgrounds a grandchild and records its pid. Killing only
    // the direct child would leave that grandchild running — the exact leak
    // RF-010's process-group kill exists to prevent.
    const h = (active = harness({
      commandOverride: (spec) => ["sh", "-c", `sleep 30 & echo $! > ${spec.cwd}/grandchild.pid; sleep 30`],
    }));
    const store = new RunStore(h.config);
    const running = store.start(spec("r-orphan"));

    const worktree = join(h.config.worktreesDir, "r-orphan");
    const pidFile = join(worktree, "grandchild.pid");
    await waitFor(() => existsSync(pidFile), "grandchild to record its pid");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    expect(store.cancel("r-orphan")).toBe(true);
    expect(await running).toMatchObject({ status: "error", exitSummary: "cancelled" });
    await waitFor(() => !alive(grandchild), "orphaned grandchild to be reaped");

    // And teardown still ran on this exit path.
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  test("timeout kills the agent, marks `timeout`, and tears the worktree down", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    const store = new RunStore(h.config);

    const result = await store.start(spec("r-timeout", { timeoutSec: 0.5 }));
    expect(result).toMatchObject({ status: "timeout", exitSummary: "timeout after 0.5s" });

    const worktree = join(h.config.worktreesDir, "r-timeout");
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);

    const kinds = events(h, "r-timeout").map((e) => e.type);
    for (const kind of ["created", "started", "teardown", "finished"]) expect(kinds).toContain(kind);
  });

  test("daemon SIGTERM kills children, marks runs, and tears worktrees down", async () => {
    // store.shutdown() is exactly what the SIGTERM handler in server.ts calls;
    // a separate test proves that handler is wired to a real signal.
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "sleep 30"] }));
    const store = new RunStore(h.config);

    const a = store.start(spec("r-sd-a"));
    const b = store.start(spec("r-sd-b"));
    await waitFor(() => h.worktrees.created.length === 2, "both worktrees to be set up");

    await store.shutdown();

    for (const result of await Promise.all([a, b])) {
      expect(result).toMatchObject({ status: "error", exitSummary: "daemon-shutdown" });
      expect(existsSync(join(h.config.worktreesDir, result.branch.replace("run/", "")))).toBe(false);
      expect(events(h, result.branch.replace("run/", "")).map((e) => e.type)).toContain("finished");
    }
    expect(h.worktrees.removed).toHaveLength(2);
    expect(store.capacity().running).toBe(0);
  });

  test("no credential ever reaches the event log", async () => {
    const h = (active = harness({ commandOverride: () => ["sh", "-c", "exit 0"] }));
    const store = new RunStore(h.config);
    await store.start(spec("r-secret", { env: { KAIROKU_PAT: "a-shared-secret-value" } }));
    expect(readFileSync(eventsPath(h.config.runsDir, "r-secret"), "utf8")).not.toContain("a-shared-secret-value");
  });
});
