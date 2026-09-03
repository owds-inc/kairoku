/**
 * Test support: a temp-dir Config, a fake WorktreeOps, a fake provider, and a
 * fake app speaking protocol v1.
 *
 * No test in this repo touches the network, a real `codex`, a real `claude` or
 * a real Kairoku. A stub agent arrives as a fake PROVIDER — the same interface
 * the SDK and codex implement — so a recipe under test runs the real state
 * machine over a scripted model.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimItem, RunEvent } from "./app";
import type { Config } from "./config";
import { launch } from "./proc";
import type { ExecContext } from "./runs";
import type { LaunchedRun, Provider, ProviderEvent, ProviderName, RoleRun } from "./providers";
import { childEnv } from "./runs";
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
    // A narrow range of its own, so a suite probing for free ports never wanders
    // into the range a daemon on the same machine is allocating from.
    ports: "23000-23999",
    token: TEST_TOKEN,
    // The interim fallback PAT (§20.7). A real daemon has one until every claim
    // carries a token per run, so a harness without one would not be a daemon.
    agentToken: TEST_AGENT_TOKEN,
    worktreeOps: worktrees,
    ...overrides,
  };

  return {
    config,
    dir,
    worktrees,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A member body that runs one shell command in the worktree — the smallest
 * thing that exercises the store's supervision without a model anywhere near
 * it. `RunStore` no longer builds commands; this is where a test's stub agent
 * lives now.
 */
export function stubExec(
  command: string[],
  options: { stdin?: string; env?: Record<string, string>; stdoutPath?: (worktree: string) => string } = {},
): (ctx: ExecContext) => Promise<{ ok: boolean; summary: string }> {
  return async (ctx) => {
    const handle = launch({
      command,
      cwd: ctx.worktree.path,
      env: childEnv(options.env ?? {}),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      stdoutPath: options.stdoutPath?.(ctx.worktree.path) ?? join(ctx.worktree.path, "stdout.log"),
      timeoutMs: 30_000,
    });
    ctx.attach({ interrupt: () => handle.cancel() });
    const result = await handle.exited;
    ctx.attach(undefined);
    return result.exitCode === 0 && result.outcome === "exited"
      ? { ok: true, summary: "exit 0" }
      : { ok: false, summary: result.outcome === "exited" ? `exit ${result.exitCode}` : result.outcome };
  };
}

// ------------------------------------------------------------ a fake provider

export interface ScriptedTurn {
  readonly events?: ProviderEvent[];
  readonly ok?: boolean;
  readonly summary?: string;
  readonly report?: unknown;
  readonly sessionId?: string;
  /** Hold the turn open until `release()` is called — for cancel tests. */
  readonly hold?: boolean;
}

export interface FakeProvider extends Provider {
  readonly launched: RoleRun[];
  /** Turns are consumed in order, per role; the last one repeats. */
  script(role: string, turns: ScriptedTurn[]): void;
  releaseAll(): void;
}

export function fakeProvider(name: ProviderName = "claude"): FakeProvider {
  const scripts = new Map<string, ScriptedTurn[]>();
  const holds = new Set<() => void>();

  const provider: FakeProvider = {
    name,
    launched: [],
    script(role, turns) {
      scripts.set(role, [...turns]);
    },
    releaseAll() {
      for (const release of [...holds]) release();
      holds.clear();
    },
    models: async () => ["fake-model-1"],
    launch(run: RoleRun): LaunchedRun {
      provider.launched.push(run);
      const queued = scripts.get(run.role);
      const turn: ScriptedTurn = (queued && (queued.length > 1 ? queued.shift()! : queued[0]!)) ?? {};

      let interrupted = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (turn.hold) holds.add(release);

      const exit = (async () => {
        if (turn.hold) await held;
        if (interrupted) return { ok: false, summary: "interrupted" };
        return {
          ok: turn.ok ?? true,
          summary: turn.summary ?? `${run.role} finished`,
          ...(turn.report === undefined ? {} : { report: turn.report }),
          ...(turn.sessionId === undefined ? {} : { sessionId: turn.sessionId }),
        };
      })();

      return {
        events: {
          async *[Symbol.asyncIterator]() {
            for (const event of turn.events ?? []) yield event;
            if (turn.hold) await held;
          },
        },
        interrupt() {
          interrupted = true;
          release();
          holds.delete(release);
        },
        exit,
      };
    },
  };
  return provider;
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
// answers at `bikerwhocodes/kairoku@eab363ea` — vendored from
// `src/app/api/daemon/{heartbeat,claim,update}/route.ts`,
// `src/lib/comms/daemon/dispatches.ts` and `src/lib/comms/protocol/index.ts`,
// including the 401 challenge, the 404-you-do-not-hold-it answer, the 409 on a
// terminal row and the invariant-7 counts refusal.
//
// Nothing here reaches the network: it binds 127.0.0.1 on an ephemeral port.

export interface FakeDispatch {
  readonly id: string;
  readonly taskType: "implement" | "research" | "plan" | "document" | "other";
  readonly brief?: string;
  readonly target?: { kind: string; id: string; title: string };
  readonly repo?: { provider: string; fullName: string; defaultBranch: string; defaultBranchSource?: string };
  readonly team?: { recipe?: string; roles?: Record<string, { provider?: string; model?: string }> };
  readonly items: ClaimItem[];
  readonly limits?: { runSeconds?: number | null };
  /** §20.11 — the profile and the values the app holds for it. Always present. */
  readonly env?: { profile: string; secrets?: Record<string, string | { ref: string }> };
}

export interface FakeRunRow {
  dispatchId: string;
  taskType: string;
  status: string;
  state?: string;
  role?: string;
  summary?: string;
  artifacts?: unknown;
  counts?: unknown;
  events: RunEvent[];
}

export interface FakeApp {
  readonly url: string;
  readonly token: string;
  readonly calls: Array<{ route: string; body: any }>;
  /** One row per RUN, which is what protocol v1 reports against. */
  readonly runs: Map<string, FakeRunRow>;
  readonly metas: any[];
  queue(dispatch: FakeDispatch): void;
  /** Answer every route with this status until it is set back to 0. */
  failWith: number;
  heartbeatIntervalMs: number;
  protocol?: string;
  /** Handed to the daemon on the next beat, then cleared (as the app does). */
  cancel: Array<{ dispatchId: string; runId?: string }>;
  stop(): Promise<void>;
}

export const FAKE_APP_TOKEN = "kai_fake_app_token";

export function fakeApp(options: { token?: string; heartbeatIntervalMs?: number; protocol?: string } = {}): FakeApp {
  const token = options.token ?? FAKE_APP_TOKEN;
  const queued: FakeDispatch[] = [];

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

  /** `applyRunReport`, including the two rules a daemon cannot route around. */
  function applyRunReport(entry: any): unknown {
    if (typeof entry?.dispatchId !== "string" || typeof entry?.runId !== "string") {
      return { ok: false, reason: "invalid", issues: ["dispatchId and runId must be uuids"] };
    }
    const row = app.runs.get(entry.runId);
    if (!row || row.dispatchId !== entry.dispatchId) return { ok: false, reason: "not-found", runId: entry.runId };
    if (row.status === "done" || row.status === "failed") {
      return { ok: false, reason: "terminal", runId: entry.runId };
    }
    if (row.taskType === "implement" && entry.status === "done" && !entry.counts) {
      return {
        ok: false,
        reason: "invalid",
        runId: entry.runId,
        issues: ["An implement run cannot report done without pass/fail/skip/errors counts."],
      };
    }
    if (entry.status !== undefined && !["running", "done", "failed"].includes(entry.status)) {
      return { ok: false, reason: "invalid", runId: entry.runId, issues: ["status must be running, done or failed"] };
    }
    if (entry.status !== undefined) row.status = entry.status;
    if (entry.state !== undefined) row.state = entry.state;
    if (entry.role !== undefined) row.role = entry.role;
    if (entry.summary !== undefined) row.summary = entry.summary;
    if (entry.artifacts !== undefined) row.artifacts = entry.artifacts;
    if (entry.counts !== undefined) row.counts = entry.counts;
    if (Array.isArray(entry.events)) row.events.push(...entry.events);
    return { ok: true, id: entry.dispatchId, runId: entry.runId, status: row.status };
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
          if (payload?.meta) app.metas.push(payload.meta);
          if (app.failWith) return Response.json({ error: "boom" }, { status: app.failWith });
          const cancel = app.cancel.splice(0, app.cancel.length);
          return Response.json({
            daemon: { id: "daemon-1", name: "fake" },
            liveness: "online",
            heartbeatIntervalMs: app.heartbeatIntervalMs,
            ...(app.protocol === undefined ? {} : { protocol: app.protocol }),
            cancel,
            runs: (payload?.runs ?? []).map(applyRunReport),
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
          for (const item of next.items) {
            app.runs.get(item.runId)!.status = "claimed";
          }
          return Response.json({
            dispatch: {
              id: next.id,
              taskType: next.taskType,
              brief: next.brief ?? "",
              project: { id: "p1", slug: "kairoku" },
              target: next.target ?? { kind: "plan_item", id: "t1", title: "a target" },
              repo: next.repo ?? null,
              team: next.team ?? null,
              items: next.items,
              // Always present, `{}` when nothing is set — a key that is
              // sometimes absent is a key every daemon has to guard.
              env: { profile: next.env?.profile ?? "test", secrets: next.env?.secrets ?? {} },
              limits: next.limits ?? { runSeconds: null },
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
          if (payload?.status === undefined) {
            return Response.json({ error: "invalid", issues: ["status is required."] }, { status: 422 });
          }
          const result = applyRunReport(payload) as any;
          if (result.ok) return Response.json(result);
          if (result.reason === "not-found") return Response.json({ error: "not-found" }, { status: 404 });
          if (result.reason === "terminal") return Response.json({ error: "terminal" }, { status: 409 });
          return Response.json({ error: "invalid", issues: result.issues }, { status: 422 });
        },
      },
    },
    fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
  });

  const app: FakeApp = {
    url: `http://127.0.0.1:${server.port}`,
    token,
    calls: [],
    runs: new Map(),
    metas: [],
    failWith: 0,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    protocol: options.protocol,
    cancel: [],
    queue(dispatch) {
      for (const item of dispatch.items) {
        app.runs.set(item.runId, {
          dispatchId: dispatch.id,
          taskType: dispatch.taskType,
          status: "queued",
          events: [],
        });
      }
      queued.push(dispatch);
    },
    stop: () => server.stop(true),
  };
  return app;
}

/** One claim item, with the run row and per-run token the app mints at claim. */
export function fakeItem(n: number, over: Partial<ClaimItem> = {}): ClaimItem {
  return {
    id: `item-${n}`,
    key: null,
    title: `Item ${n}`,
    body: `## Change\nDo thing ${n}.`,
    runId: `run-${n}`,
    runToken: `kai_run_token_${n}`,
    ...over,
  };
}
