/**
 * Run lifecycle (RF-005, RF-010) — and, since O-3, the daemon's ONE registry of
 * what is live.
 *
 * A RUN IS NOW A MEMBER OF A TEAM, not a process. `start()` takes a body to
 * execute inside a fresh worktree; what that body does — one codex process, a
 * three-role Claude sequence with a fix loop — is `dispatch.ts`'s and
 * `recipes.ts`'s business. This module owns the four things that are the same
 * whichever team runs: capacity, the worktree, teardown on every exit path, and
 * a cancel that reaches whatever is currently running.
 *
 * The role table that used to live beside this (RF-009, `executor`) is retired
 * here as SPEC v1 said it would be: `providers/` and `policy.ts` replace it.
 *
 * RF-007 (amended): nothing here talks outward. Only `app.ts` does.
 */

import type { RunEvent, RunState } from "./app";
import type { Config } from "./config";
import { EventBuffer, appendEvent, ensureRunDir } from "./events";
import type { RoleName } from "./policy";
import { gitWorktreeOps, type Worktree, type WorktreeOps } from "./worktree";

/** The local outcome of a member. The app's vocabulary is `state` + `status`. */
export type RunStatus = "running" | "idle" | "error" | "timeout";

export interface ExecContext {
  readonly worktree: Worktree;
  /** The curated channel for this member; drained by the beat. */
  readonly events: EventBuffer;
  /** Register whatever is currently interruptible, so a cancel reaches it. */
  attach(handle: { interrupt(): void } | undefined): void;
  /** What the Floor prints while this is happening. */
  setState(state: RunState, role?: RoleName): void;
  /** True once the app, a timeout or a shutdown has asked this run to stop. */
  cancelled(): boolean;
}

export interface StartSpec {
  readonly dispatchId: string;
  /** The app's `dispatch_runs.id`. The key of this store and of every report. */
  readonly runId: string;
  /** The worktree directory name; the branch is `run/<name>`. */
  readonly name: string;
  readonly role?: RoleName;
  /** What the worktree is cut from, e.g. `origin/main`. */
  readonly base?: string;
  readonly timeoutSec?: number;
  /** Values delivered to this run, masked out of both logs. */
  readonly secrets?: readonly string[];
  readonly onStarted?: (started: RunStarted) => void;
  /** The team, as a function of one worktree. */
  readonly execute: (ctx: ExecContext) => Promise<{ ok: boolean; summary: string }>;
}

export interface RunStarted {
  readonly branch: string;
  readonly worktree: string;
}

export interface RunResult {
  readonly status: RunStatus;
  readonly exitSummary: string;
  readonly branch: string;
  readonly worktree?: string;
}

/** One in-flight run, as `/status` shows it and as the beat reports it. */
export interface RunListing {
  readonly dispatchId: string;
  readonly runId: string;
  readonly role?: RoleName;
  readonly state: RunState;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly branch: string;
}

interface RunRecord {
  readonly dispatchId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly timeoutSec: number;
  readonly events: EventBuffer;
  status: RunStatus;
  state: RunState;
  role?: RoleName;
  branch: string;
  worktree?: Worktree;
  handle?: { interrupt(): void };
  stopping?: "cancelled" | "timeout" | "shutdown";
  /** Registered, but waiting for a slot. Not running, and not counted as such. */
  queued?: boolean;
}

export class RunStore {
  readonly #config: Config;
  readonly #worktrees: WorktreeOps;
  readonly #runs = new Map<string, RunRecord>();
  /** In-flight supervision promises, awaited by `shutdown`. */
  readonly #inflight = new Set<Promise<void>>();
  /** Members waiting for a slot, oldest first. One release wakes exactly one. */
  readonly #waiting: Array<() => void> = [];
  #shuttingDown = false;

  constructor(config: Config) {
    this.#config = config;
    this.#worktrees = config.worktreeOps ?? gitWorktreeOps(config.repoPath, config.worktreesDir);
  }

  runningCount(): number {
    let n = 0;
    for (const run of this.#runs.values()) if (run.status === "running" && !run.queued) n++;
    return n;
  }

  /** RF-005. */
  capacity(): { running: number; max: number } {
    return { running: this.runningCount(), max: this.#config.maxConcurrent };
  }

  /** How many members could start right now. The claim loop and the fan-out both ask. */
  free(): number {
    const { running, max } = this.capacity();
    return Math.max(0, max - running);
  }

  list(): RunListing[] {
    const out: RunListing[] = [];
    for (const run of this.#runs.values()) {
      if (run.status !== "running" || run.queued) continue;
      out.push({
        dispatchId: run.dispatchId,
        runId: run.runId,
        ...(run.role === undefined ? {} : { role: run.role }),
        state: run.state,
        status: run.status,
        startedAt: run.startedAt,
        branch: run.branch,
      });
    }
    return out;
  }

  /** The curated lines each live run has waiting, taken for one beat. */
  drainEvents(runId: string, max?: number): RunEvent[] {
    return this.#runs.get(runId)?.events.drain(max) ?? [];
  }

  /**
   * Start one member and resolve when it reaches a terminal state.
   *
   * The record is registered SYNCHRONOUSLY, before the first await, so the very
   * next `capacity()` already counts it — the claim loop gates on that number
   * and a slot that appears free for one tick is a double claim.
   *
   * CAPACITY IS ENFORCED HERE AND NOWHERE ELSE. A caller cannot be trusted to
   * bound itself: two dispatches overlap by design (the claim loop refuses only
   * when NOTHING is free), so a fan-out that bounded itself by `maxConcurrent`
   * would put a whole machine's worth of members on top of the ones already
   * running. A member past the limit WAITS rather than being refused — it was
   * claimed, it is owed a run.
   */
  async start(spec: StartSpec): Promise<RunResult> {
    const runsDir = this.#config.runsDir;
    ensureRunDir(runsDir, spec.dispatchId);
    const record: RunRecord = {
      dispatchId: spec.dispatchId,
      runId: spec.runId,
      startedAt: new Date().toISOString(),
      timeoutSec: spec.timeoutSec ?? this.#config.defaultTimeoutSec,
      events: new EventBuffer({
        runsDir,
        dispatchId: spec.dispatchId,
        runId: spec.runId,
        ...(spec.secrets === undefined ? {} : { secrets: spec.secrets }),
      }),
      status: "running",
      state: "starting",
      queued: true,
      ...(spec.role === undefined ? {} : { role: spec.role }),
      branch: `run/${spec.name}`,
    };
    this.#runs.set(spec.runId, record);

    appendEvent(runsDir, spec.dispatchId, spec.runId, "created", {
      role: spec.role,
      branch: record.branch,
      base: spec.base,
      timeoutSec: record.timeoutSec,
    });

    const supervision = this.#supervise(record, spec);
    const tracked = supervision.then(
      () => {},
      () => {},
    );
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
    return supervision;
  }

  /** RF-004 — stop one run: interrupt what it is doing, tear down, report `cancelled`. */
  cancel(runId: string): boolean {
    return this.#stop(runId, "cancelled");
  }

  /** Every run of one dispatch. The beat's `cancel[]` carries both shapes. */
  cancelDispatch(dispatchId: string): number {
    let stopped = 0;
    for (const run of this.#runs.values()) {
      if (run.dispatchId === dispatchId && this.#stop(run.runId, "cancelled")) stopped++;
    }
    return stopped;
  }

  #stop(runId: string, reason: "cancelled" | "timeout" | "shutdown"): boolean {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.stopping ??= reason;
    // A queued member has nothing to interrupt yet; it honours the flag the
    // moment a slot frees, which shutdown's `await` on #inflight waits for.
    // A stop may land before the worktree is ready and anything exists to
    // interrupt; #supervise re-checks the flag at every point it could be set.
    run.handle?.interrupt();
    return true;
  }

  /** RF-010 — daemon SIGTERM: stop children, mark runs, write final events. */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const run of this.#runs.values()) if (run.status === "running") this.#stop(run.runId, "shutdown");
    await Promise.allSettled([...this.#inflight]);
  }

  /** Wait for a slot. Every `#acquire` is paired with exactly one `#release`. */
  async #acquire(record: RunRecord): Promise<void> {
    if (this.runningCount() >= this.#config.maxConcurrent) {
      await new Promise<void>((go) => this.#waiting.push(go));
    }
    record.queued = false;
  }

  #release(): void {
    this.#waiting.shift()?.();
  }

  async #supervise(record: RunRecord, spec: StartSpec): Promise<RunResult> {
    await this.#acquire(record);
    try {
      return await this.#run(record, spec);
    } finally {
      // The slot is already free here: #finish has taken the record out of
      // `running`, so whoever we wake counts itself correctly.
      this.#release();
    }
  }

  async #run(record: RunRecord, spec: StartSpec): Promise<RunResult> {
    const runsDir = this.#config.runsDir;

    // A cancel or a shutdown can land while a member is queued. Honour it
    // before cutting a worktree there is no longer any reason to cut.
    if (record.stopping || this.#shuttingDown) {
      const [status, summary] = classify(record, { ok: false, summary: "never started" });
      return this.#finish(record, status, summary);
    }

    let worktree: Worktree;
    try {
      worktree = await this.#worktrees.create(spec.name, spec.base);
    } catch (err) {
      return this.#finish(record, "error", `worktree-setup-failed: ${message(err)}`);
    }
    record.worktree = worktree;
    record.branch = worktree.branch;

    if (record.stopping || this.#shuttingDown) {
      await this.#teardown(record);
      const [status, summary] = classify(record, { ok: false, summary: "never started" });
      return this.#finish(record, status, summary);
    }

    appendEvent(runsDir, record.dispatchId, record.runId, "started", {
      branch: record.branch,
      worktree: worktree.path,
    });
    record.state = "running";
    spec.onStarted?.({ branch: record.branch, worktree: worktree.path });

    // §20 item 8 — the per-run wall clock. A run that will not stop is a slot
    // that never comes back, which is worse for the next dispatch than this
    // one failing.
    const timer = setTimeout(() => this.#stop(record.runId, "timeout"), record.timeoutSec * 1000);
    timer.unref?.();

    let outcome: { ok: boolean; summary: string };
    try {
      outcome = await spec.execute({
        worktree,
        events: record.events,
        attach: (handle) => {
          record.handle = handle;
          // An interrupt requested while nothing was attached still lands.
          if (record.stopping) handle?.interrupt();
        },
        setState: (state, role) => {
          record.state = state;
          if (role) record.role = role;
        },
        cancelled: () => record.stopping !== undefined || this.#shuttingDown,
      });
    } catch (err) {
      appendEvent(runsDir, record.dispatchId, record.runId, "error", { message: message(err) });
      clearTimeout(timer);
      await this.#teardown(record);
      return this.#finish(record, "error", `the run threw: ${message(err)}`);
    }
    clearTimeout(timer);

    const [status, summary] = classify(record, outcome);
    await this.#teardown(record, status);
    return this.#finish(record, status, summary);
  }

  /** RF-010 — worktree teardown on every exit path, with the post-mortem opt-out. */
  async #teardown(record: RunRecord, status?: RunStatus): Promise<void> {
    const runsDir = this.#config.runsDir;
    if (!record.worktree) return;
    const failed = status !== undefined && status !== "idle";
    if (failed && this.#config.keepWorktreeOnFailure) {
      appendEvent(runsDir, record.dispatchId, record.runId, "teardown", {
        removed: false,
        reason: "keepWorktreeOnFailure",
        worktree: record.worktree.path,
      });
      return;
    }
    try {
      await this.#worktrees.remove(record.worktree);
      appendEvent(runsDir, record.dispatchId, record.runId, "teardown", {
        removed: true,
        worktree: record.worktree.path,
        branch: record.worktree.branch,
      });
    } catch (err) {
      // The branch survives regardless; a stuck worktree is `kairoku daemon prune`'s.
      appendEvent(runsDir, record.dispatchId, record.runId, "teardown", {
        removed: false,
        reason: message(err),
        worktree: record.worktree.path,
      });
    }
  }

  #finish(record: RunRecord, status: RunStatus, exitSummary: string): RunResult {
    record.status = status;
    record.state = "finishing";
    record.handle = undefined;
    appendEvent(this.#config.runsDir, record.dispatchId, record.runId, "finished", {
      status,
      exitSummary,
      branch: record.branch,
    });
    return {
      status,
      exitSummary,
      branch: record.branch,
      ...(record.worktree === undefined ? {} : { worktree: record.worktree.path }),
    };
  }
}

/**
 * What the run was stopped FOR outranks what its body returned: a body that
 * notices the cancel and returns tidily is still a cancelled run, and reporting
 * it as an ordinary failure would lose the one fact a reader needs.
 */
function classify(record: RunRecord, outcome: { ok: boolean; summary: string }): [RunStatus, string] {
  if (record.stopping === "timeout") return ["timeout", `time limit: ${record.timeoutSec}s`];
  if (record.stopping === "cancelled") return ["error", "cancelled by the app"];
  if (record.stopping === "shutdown") return ["error", "daemon-shutdown"];
  return outcome.ok ? ["idle", outcome.summary] : ["error", outcome.summary];
}

/**
 * The agent inherits the daemon's environment plus the run's injected vars.
 * The daemon's own app credential (KAIROKU_DAEMON_TOKEN, or the pre-rename
 * HIKYAKU_TOKEN) is stripped, and so is the interim agent-token fallback: an
 * agent gets exactly the one PAT its run was given, never the daemon's.
 */
export function childEnv(injected: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.KAIROKU_DAEMON_TOKEN;
  delete env.HIKYAKU_TOKEN;
  delete env.KAIROKU_AGENT_TOKEN;
  return { ...env, ...injected };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
