/**
 * Run lifecycle (RF-005, RF-009, RF-010).
 *
 * State is a `Map` and nothing else — no database by design. The app owns
 * recovery; `dispatch.ts` writes the one thing that must survive a restart.
 *
 * The refusal set went with the push API (SPEC v1, §20.3): it existed to answer
 * an inbound `POST /runs`, and there is no inbound caller left to refuse. The
 * daemon now chooses what to run, from what it claimed, inside its own capacity.
 *
 * RF-007 (amended): nothing here talks outward. Only `app.ts` does, and only to
 * the three daemon routes.
 */

import type { Config } from "./config";
import { appendEvent, ensureRunDir, stdoutPath } from "./events";
import { getRole } from "./roles";
import { launch, type ProcHandle, type ProcResult } from "./proc";
import {
  branchFor,
  gitWorktreeOps,
  type Worktree,
  type WorktreeOps,
} from "./worktree";

/**
 * `blocked` is reserved in the vocabulary but unreachable: `codex exec` with
 * approval_policy "never" never parks. It is not emitted.
 */
export type RunStatus = "running" | "idle" | "error" | "timeout";

/**
 * RF-009 — the one role in the table, and the provider a `solo` run uses.
 * Claude arrives in O-3 with the Agent SDK and §20.8's per-role tool policy;
 * inventing a half-provider here that O-3 replaces would be churn.
 */
export const SOLO_ROLE = "executor";

export interface StartSpec {
  /** The dispatch id. It is the run id, the branch suffix and the runs-dir name. */
  readonly id: string;
  readonly brief: string;
  /** Injected over the daemon's own environment; carries `KAIROKU_PAT`. */
  readonly env: Record<string, string>;
  /** What the worktree is cut from, e.g. `origin/main`. */
  readonly base?: string;
  readonly timeoutSec?: number;
  /** Fired once the agent is spawned — where the `update running` report hangs. */
  readonly onStarted?: (started: RunStarted) => void;
}

export interface RunStarted {
  readonly pid?: number;
  readonly branch: string;
  readonly worktree: string;
}

export interface RunResult {
  readonly status: RunStatus;
  readonly exitSummary: string;
  readonly branch: string;
  readonly worktree?: string;
}

/** One in-flight run, as `GET /status` shows it. */
export interface RunListing {
  readonly dispatchId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly branch: string;
}

interface RunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly timeoutSec: number;
  status: RunStatus;
  branch: string;
  exitSummary?: string;
  worktree?: Worktree;
  handle?: ProcHandle;
  cancelRequested: boolean;
}

export class RunStore {
  readonly #config: Config;
  readonly #worktrees: WorktreeOps;
  readonly #runs = new Map<string, RunRecord>();
  /** In-flight supervision promises, awaited by `shutdown`. */
  readonly #inflight = new Set<Promise<void>>();
  #shuttingDown = false;

  constructor(config: Config) {
    this.#config = config;
    this.#worktrees =
      config.worktreeOps ??
      gitWorktreeOps(config.repoPath, config.worktreesDir);
  }

  runningCount(): number {
    let n = 0;
    for (const run of this.#runs.values()) if (run.status === "running") n++;
    return n;
  }

  /** RF-005. */
  capacity(): { running: number; max: number } {
    return { running: this.runningCount(), max: this.#config.maxConcurrent };
  }

  /** The in-flight runs, for `GET /status` and the heartbeat's capacity. */
  list(): RunListing[] {
    const out: RunListing[] = [];
    for (const run of this.#runs.values()) {
      if (run.status === "running") {
        out.push({ dispatchId: run.id, status: run.status, startedAt: run.startedAt, branch: run.branch });
      }
    }
    return out;
  }

  /**
   * Start one run and resolve when it reaches a terminal state.
   *
   * The record is registered SYNCHRONOUSLY, before the first await, so the very
   * next `capacity()` already counts it — the claim loop gates on that number
   * and a slot that appears free for one tick is a double claim.
   */
  async start(spec: StartSpec): Promise<RunResult> {
    const id = spec.id;
    const record: RunRecord = {
      id,
      startedAt: new Date().toISOString(),
      timeoutSec: spec.timeoutSec ?? this.#config.defaultTimeoutSec,
      status: "running",
      branch: branchFor(id),
      cancelRequested: false,
    };
    this.#runs.set(id, record);

    ensureRunDir(this.#config.runsDir, id);
    appendEvent(this.#config.runsDir, id, "created", {
      role: SOLO_ROLE,
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

  /** RF-004 — group kill, teardown, `error` / "cancelled". */
  cancel(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.cancelRequested = true;
    // Cancel may land before the worktree is ready and the process exists;
    // #supervise checks the flag at every point it could have been set.
    run.handle?.cancel();
    return true;
  }

  /** RF-010 — daemon SIGTERM: kill children, mark runs, write final events. */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const run of this.#runs.values()) {
      if (run.status === "running") run.handle?.shutdown();
    }
    await Promise.allSettled([...this.#inflight]);
  }

  async #supervise(record: RunRecord, spec: StartSpec): Promise<RunResult> {
    const runsDir = this.#config.runsDir;

    let worktree: Worktree;
    try {
      worktree = await this.#worktrees.create(record.id, spec.base);
    } catch (err) {
      return this.#finish(record, "error", `worktree-setup-failed: ${message(err)}`);
    }
    record.worktree = worktree;
    record.branch = worktree.branch;

    // A cancel or shutdown that arrived during setup: never start the agent.
    if (record.cancelRequested || this.#shuttingDown) {
      await this.#teardown(record);
      return this.#finish(
        record,
        "error",
        record.cancelRequested ? "cancelled" : "daemon-shutdown",
      );
    }

    const commandSpec = { role: SOLO_ROLE, cwd: worktree.path };
    const command = this.#config.commandOverride
      ? this.#config.commandOverride(commandSpec)
      : getRole(SOLO_ROLE)!.build(commandSpec);

    let result: ProcResult;
    try {
      const handle = launch({
        command,
        cwd: worktree.path,
        env: childEnv(spec.env),
        stdin: spec.brief,
        stdoutPath: stdoutPath(runsDir, record.id),
        timeoutMs: record.timeoutSec * 1000,
        killGraceMs: this.#config.killGraceMs,
      });
      record.handle = handle;
      appendEvent(runsDir, record.id, "started", {
        pid: handle.pid,
        branch: record.branch,
        worktree: worktree.path,
        // Argv only — the brief goes over stdin and no credential is in it.
        command: command.join(" "),
      });
      spec.onStarted?.({ pid: handle.pid, branch: record.branch, worktree: worktree.path });
      // cancel()/shutdown() may have fired between the flag check and here.
      if (record.cancelRequested) handle.cancel();
      else if (this.#shuttingDown) handle.shutdown();

      result = await handle.exited;
    } catch (err) {
      appendEvent(runsDir, record.id, "error", { message: message(err) });
      await this.#teardown(record);
      return this.#finish(record, "error", `spawn-failed: ${message(err)}`);
    }

    const [status, summary] = classify(result, record.timeoutSec);
    await this.#teardown(record, status);
    return this.#finish(record, status, summary);
  }

  /** RF-010 — worktree teardown on every exit path, with the post-mortem opt-out. */
  async #teardown(record: RunRecord, status?: RunStatus): Promise<void> {
    const runsDir = this.#config.runsDir;
    if (!record.worktree) return;
    const failed = status !== undefined && status !== "idle";
    if (failed && this.#config.keepWorktreeOnFailure) {
      appendEvent(runsDir, record.id, "teardown", {
        removed: false,
        reason: "keepWorktreeOnFailure",
        worktree: record.worktree.path,
      });
      return;
    }
    try {
      await this.#worktrees.remove(record.worktree);
      appendEvent(runsDir, record.id, "teardown", {
        removed: true,
        worktree: record.worktree.path,
        branch: record.worktree.branch,
      });
    } catch (err) {
      // The branch survives regardless; a stuck worktree is `kairoku daemon prune`'s.
      appendEvent(runsDir, record.id, "teardown", {
        removed: false,
        reason: message(err),
        worktree: record.worktree.path,
      });
    }
  }

  #finish(record: RunRecord, status: RunStatus, exitSummary: string): RunResult {
    record.status = status;
    record.exitSummary = exitSummary;
    record.handle = undefined;
    appendEvent(this.#config.runsDir, record.id, "finished", {
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

function classify(
  result: ProcResult,
  timeoutSec: number,
): [RunStatus, string] {
  switch (result.outcome) {
    case "timeout":
      return ["timeout", `timeout after ${timeoutSec}s`];
    case "cancelled":
      return ["error", "cancelled"];
    case "shutdown":
      return ["error", "daemon-shutdown"];
    case "exited":
      if (result.error) return ["error", `spawn-failed: ${result.error}`];
      if (result.signal) return ["error", `signal ${result.signal}`];
      return result.exitCode === 0
        ? ["idle", "exit 0"]
        : ["error", `exit ${result.exitCode}`];
  }
}

/**
 * The agent inherits the daemon's environment plus the run's injected vars.
 * The daemon's own app credential (KAIROKU_DAEMON_TOKEN, or the pre-rename
 * HIKYAKU_TOKEN) is stripped, and so is the interim agent-token fallback: an
 * agent gets exactly the one PAT its run was given, never the daemon's.
 */
function childEnv(injected: Record<string, string>): Record<string, string> {
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
