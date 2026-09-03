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
 * No real `codex`, no `claude`, no network. The stub agent is the smallest
 * possible member body — one shell command — through `stubExec`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "./runs";
import { eventsPath, stdoutPath } from "./events";
import { harness, stubExec, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function events(h: Harness, runId: string): Array<Record<string, unknown>> {
  const path = eventsPath(h.config.runsDir, runId, runId);
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

const spec = (h: Harness, id: string, command: (cwd: string) => string, extra: Record<string, unknown> = {}) => ({
  dispatchId: id,
  runId: id,
  name: id,
  execute: async (ctx: Parameters<Parameters<RunStore["start"]>[0]["execute"]>[0]) =>
    stubExec(["sh", "-c", command(ctx.worktree.path)], {
      env: { KAIROKU_PAT: `pat-${id}` },
      stdoutPath: () => stdoutPath(h.config.runsDir, id, id),
    })(ctx),
  ...extra,
});

describe("supervision", () => {
  test("cancel reaps orphans: a grandchild of the agent dies with the group", async () => {
    // The stub agent backgrounds a grandchild and records its pid. Killing only
    // the direct child would leave that grandchild running — the exact leak
    // RF-010's process-group kill exists to prevent.
    const h = (active = harness());
    const store = new RunStore(h.config);
    const running = store.start(
      spec(h, "r-orphan", (cwd) => `sleep 30 & echo $! > ${cwd}/grandchild.pid; sleep 30`),
    );

    const worktree = join(h.config.worktreesDir, "r-orphan");
    const pidFile = join(worktree, "grandchild.pid");
    await waitFor(() => existsSync(pidFile), "grandchild to record its pid");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(true);

    expect(store.cancel("r-orphan")).toBe(true);
    expect(await running).toMatchObject({ status: "error", exitSummary: "cancelled by the app" });
    await waitFor(() => !alive(grandchild), "orphaned grandchild to be reaped");

    // And teardown still ran on this exit path.
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  test("timeout kills the agent, marks `timeout`, and tears the worktree down", async () => {
    const h = (active = harness());
    const store = new RunStore(h.config);

    const result = await store.start(spec(h, "r-timeout", () => "sleep 30", { timeoutSec: 0.5 }));
    expect(result).toMatchObject({ status: "timeout", exitSummary: "time limit: 0.5s" });

    const worktree = join(h.config.worktreesDir, "r-timeout");
    expect(h.worktrees.removed.map((w) => w.path)).toContain(worktree);
    expect(existsSync(worktree)).toBe(false);

    const kinds = events(h, "r-timeout").map((e) => e.type);
    for (const kind of ["created", "started", "teardown", "finished"]) expect(kinds).toContain(kind);
  });

  test("daemon SIGTERM kills children, marks runs, and tears worktrees down", async () => {
    // store.shutdown() is exactly what the SIGTERM handler in server.ts calls;
    // a separate test proves that handler is wired to a real signal.
    const h = (active = harness());
    const store = new RunStore(h.config);

    const a = store.start(spec(h, "r-sd-a", () => "sleep 30"));
    const b = store.start(spec(h, "r-sd-b", () => "sleep 30"));
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
    const h = (active = harness());
    const store = new RunStore(h.config);
    await store.start({
      ...spec(h, "r-secret", () => 'echo "$KAIROKU_PAT"'),
      secrets: ["a-shared-secret-value"],
      execute: async (ctx) => {
        // The worst case: the agent echoes its own credential back at us.
        ctx.events.push("text", "my token is a-shared-secret-value");
        return { ok: true, summary: "exit 0" };
      },
    });
    expect(readFileSync(eventsPath(h.config.runsDir, "r-secret", "r-secret"), "utf8")).not.toContain(
      "a-shared-secret-value",
    );
    expect(JSON.stringify(store.drainEvents("r-secret"))).not.toContain("a-shared-secret-value");
  });
});
