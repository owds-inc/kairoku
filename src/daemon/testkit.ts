/**
 * Test support: a temp-dir Config, a fake WorktreeOps, and stub agent commands.
 *
 * No test in this repo touches the network, a real `codex`, or a real Kairoku.
 * The role table is never given a test-mode entry (RF-009) — stub commands
 * arrive through `Config.commandOverride`, which production config cannot set.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import type { Worktree, WorktreeOps } from "./worktree";
import { branchFor } from "./worktree";

export interface FakeWorktrees extends WorktreeOps {
  readonly created: Worktree[];
  /** The `base` each create() was asked for — `origin/<defaultBranch>`. */
  readonly bases: Array<string | undefined>;
  readonly removed: Worktree[];
  /** Make the next create() reject, to exercise the setup-failure path. */
  failNext: boolean;
  /** Delay create() so cancel/shutdown can land mid-setup. */
  delayMs: number;
}

export function fakeWorktrees(root: string): FakeWorktrees {
  const ops: FakeWorktrees = {
    created: [],
    bases: [],
    removed: [],
    failNext: false,
    delayMs: 0,
    async create(runId, base) {
      ops.bases.push(base);
      if (ops.delayMs) await Bun.sleep(ops.delayMs);
      if (ops.failNext) {
        ops.failNext = false;
        throw new Error("fetch refused");
      }
      const path = join(root, runId);
      mkdirSync(path, { recursive: true });
      const worktree = { path, branch: branchFor(runId) };
      ops.created.push(worktree);
      return worktree;
    },
    async remove(worktree) {
      ops.removed.push(worktree);
      rmSync(worktree.path, { recursive: true, force: true });
    },
  };
  return ops;
}

export interface Harness {
  readonly config: Config;
  readonly dir: string;
  readonly worktrees: FakeWorktrees;
  cleanup(): void;
}

export const TEST_TOKEN = "test-bearer-token";
export const TEST_AGENT_TOKEN = "test-agent-token";

export function harness(overrides: Partial<Config> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-test-"));
  const worktreesDir = join(dir, "worktrees");
  const runsDir = join(dir, "runs");
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const worktrees = fakeWorktrees(worktreesDir);

  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    maxConcurrent: 2,
    repoPath: join(dir, "repo"),
    worktreesDir,
    runsDir,
    keepWorktreeOnFailure: false,
    defaultTimeoutSec: 30,
    killGraceMs: 150,
    defaultBranch: "main",
    token: TEST_TOKEN,
    // The interim fallback PAT (§20.7). A real daemon has one until O-2 mints
    // a token per run, so a harness without one would not be a daemon.
    agentToken: TEST_AGENT_TOKEN,
    worktreeOps: worktrees,
    // Default stub agent: exits 0 immediately, reading its brief from stdin.
    commandOverride: () => ["sh", "-c", "cat > brief.txt"],
    ...overrides,
  };

  return {
    config,
    dir,
    worktrees,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Poll until `predicate` holds, or fail loudly rather than hang the suite. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for: ${message}`);
}

export function pathGone(path: string): boolean {
  return !existsSync(path);
}

// --------------------------------------------------------------- the fake app
//
// `Bun.serve` speaking the three daemon routes with the shapes the real app
// answers at `bikerwhocodes/kairoku@a986e23b` — vendored from
// `src/app/api/daemon/{heartbeat,claim,update}/route.ts` and
// `src/lib/orchestration/dispatches.ts`, including the 401 challenge, the
// 404-you-do-not-hold-it answer and the invariant-7 counts refusal.
//
// Nothing here reaches the network: it binds 127.0.0.1 on an ephemeral port.

export interface FakeDispatch {
  readonly id: string;
  readonly taskType: "implement" | "research" | "plan" | "other";
  readonly brief: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly createdAt?: string;
  readonly repo?: { provider: string; fullName: string; defaultBranch: string };
  readonly items?: Array<{ id: string; runToken?: string }>;
}

export interface FakeRow {
  taskType: string;
  status: string;
  claimed: boolean;
  summary?: string;
  artifacts?: unknown;
  counts?: unknown;
}

export interface FakeApp {
  readonly url: string;
  readonly token: string;
  readonly calls: Array<{ route: string; body: unknown }>;
  readonly rows: Map<string, FakeRow>;
  queue(dispatch: FakeDispatch): void;
  /** Answer every route with this status until it is set back to 0. */
  failWith: number;
  heartbeatIntervalMs: number;
  protocol?: string;
  stop(): Promise<void>;
}

export const FAKE_APP_TOKEN = "kai_fake_app_token";

export function fakeApp(options: { token?: string; heartbeatIntervalMs?: number; protocol?: string } = {}): FakeApp {
  const token = options.token ?? FAKE_APP_TOKEN;
  const queued: FakeDispatch[] = [];
  const dispatches = new Map<string, FakeDispatch>();

  const unauthorized = () =>
    Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

  const authed = (req: Request) => req.headers.get("authorization") === `Bearer ${token}`;

  const body = async (req: Request): Promise<any> => {
    try {
      return await req.json();
    } catch {
      return undefined;
    }
  };

  /** `applyDispatchUpdate`, including the rule the daemon cannot route around. */
  function applyUpdate(entry: any): unknown {
    if (typeof entry?.dispatchId !== "string") {
      return { ok: false, reason: "invalid", issues: ["dispatchId must be a uuid"] };
    }
    const row = app.rows.get(entry.dispatchId);
    if (!row || !row.claimed) return { ok: false, reason: "not-found" };
    if (row.taskType === "implement" && entry.status === "done" && !entry.counts) {
      return {
        ok: false,
        reason: "invalid",
        issues: ["An implement run cannot report done without pass/fail/skip/errors counts."],
      };
    }
    if (!["running", "done", "failed"].includes(entry.status)) {
      return { ok: false, reason: "invalid", issues: ["status must be running, done or failed"] };
    }
    row.status = entry.status;
    if (entry.summary !== undefined) row.summary = entry.summary;
    if (entry.artifacts !== undefined) row.artifacts = entry.artifacts;
    if (entry.counts !== undefined) row.counts = entry.counts;
    return { ok: true, id: entry.dispatchId, status: entry.status };
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/daemon/heartbeat": {
        POST: async (req) => {
          if (!authed(req)) return unauthorized();
          const payload = await body(req);
          app.calls.push({ route: "heartbeat", body: payload });
          if (app.failWith) return Response.json({ error: "boom" }, { status: app.failWith });
          return Response.json({
            daemon: { id: "daemon-1", name: "fake" },
            liveness: "online",
            heartbeatIntervalMs: app.heartbeatIntervalMs,
            ...(app.protocol === undefined ? {} : { protocol: app.protocol }),
            runs: (payload?.runs ?? []).map(applyUpdate),
          });
        },
      },
      "/api/daemon/claim": {
        POST: async (req) => {
          if (!authed(req)) return unauthorized();
          app.calls.push({ route: "claim", body: await body(req) });
          if (app.failWith) return Response.json({ error: "boom" }, { status: app.failWith });
          const next = queued.shift();
          if (!next) return Response.json({ dispatch: null });
          app.rows.get(next.id)!.claimed = true;
          app.rows.get(next.id)!.status = "claimed";
          return Response.json({
            dispatch: {
              id: next.id,
              targetKind: next.targetKind ?? "plan_item",
              targetId: next.targetId ?? "target-1",
              taskType: next.taskType,
              brief: next.brief,
              createdAt: next.createdAt ?? new Date().toISOString(),
              ...(next.repo === undefined ? {} : { repo: next.repo }),
              ...(next.items === undefined ? {} : { items: next.items }),
            },
          });
        },
      },
      "/api/daemon/update": {
        POST: async (req) => {
          if (!authed(req)) return unauthorized();
          const payload = await body(req);
          app.calls.push({ route: "update", body: payload });
          if (app.failWith) return Response.json({ error: "boom" }, { status: app.failWith });
          const result = applyUpdate(payload) as any;
          if (result.ok) return Response.json(result);
          return result.reason === "not-found"
            ? Response.json({ error: "not-found" }, { status: 404 })
            : Response.json({ error: "invalid", issues: result.issues }, { status: 422 });
        },
      },
    },
    fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
  });

  const app: FakeApp = {
    url: `http://127.0.0.1:${server.port}`,
    token,
    calls: [],
    rows: new Map(),
    failWith: 0,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    protocol: options.protocol,
    queue(dispatch) {
      dispatches.set(dispatch.id, dispatch);
      app.rows.set(dispatch.id, { taskType: dispatch.taskType, status: "queued", claimed: false });
      queued.push(dispatch);
    },
    stop: () => server.stop(true),
  };
  return app;
}
