/**
 * Run lifecycle and the refusal set (RF-001, RF-002, RF-004, RF-005, RF-008,
 * RF-010).
 *
 * State is a `Map` and nothing else — no database by design. The ledger in the
 * Kairoku app owns recovery; losing this process loses nothing that matters.
 *
 * RF-007: nothing here talks to Kairoku, Jira or GitHub. The daemon holds no
 * credential for any of them; the agents it launches do all reporting under
 * their own identity.
 */

import { createHash, randomBytes } from "node:crypto";
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
 * RF-002. `blocked` is reserved in the vocabulary but unreachable in v0:
 * `codex exec` with approval_policy "never" never parks. It is not emitted.
 */
export type RunStatus = "running" | "idle" | "error" | "timeout";

export const REFUSAL_REASONS = [
  "capacity_full",
  "unknown_role",
  "missing_credential",
  "duplicate_credential",
  "empty_brief",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface RunRequest {
  role?: string;
  provider?: string;
  model?: string;
  brief?: string;
  repo?: string;
  worktree?: { base?: string };
  env?: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSec?: number;
}

/** RF-002 response shape. */
export interface RunView {
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly branch: string;
  readonly exitSummary?: string;
}

interface RunRecord {
  readonly id: string;
  readonly role: string;
  readonly provider: string;
  readonly model?: string;
  readonly startedAt: string;
  readonly timeoutSec: number;
  readonly labels?: Record<string, string>;
  /** SHA-256 of the injected KAIROKU_PAT. The value itself is never stored. */
  readonly credHash: string;
  status: RunStatus;
  branch: string;
  exitSummary?: string;
  worktree?: Worktree;
  handle?: ProcHandle;
  cancelRequested: boolean;
}

export type CreateResult =
  | { ok: true; runId: string }
  | { ok: false; reason: RefusalReason };

export function hashCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newRunId(): string {
  return randomBytes(6).toString("hex");
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

  /** RF-002. */
  view(runId: string): RunView | undefined {
    const run = this.#runs.get(runId);
    if (!run) return undefined;
    return {
      status: run.status,
      startedAt: run.startedAt,
      branch: run.branch,
      ...(run.exitSummary === undefined ? {} : { exitSummary: run.exitSummary }),
    };
  }

  /** RF-001 — create or refuse. Never queues. */
  create(req: RunRequest): CreateResult {
    const brief = (req.brief ?? "").trim();
    if (!brief) return { ok: false, reason: "empty_brief" };

    const role = req.role ? getRole(req.role) : undefined;
    if (!role) return { ok: false, reason: "unknown_role" };

    const pat = (req.env?.KAIROKU_PAT ?? "").trim();
    if (!pat) return { ok: false, reason: "missing_credential" };

    if (this.runningCount() >= this.#config.maxConcurrent) {
      return { ok: false, reason: "capacity_full" };
    }

    // RF-008 — mechanical distinctness, by hash. Never by value.
    const credHash = hashCredential(pat);
    for (const other of this.#runs.values()) {
      if (other.status === "running" && other.credHash === credHash) {
        return { ok: false, reason: "duplicate_credential" };
      }
    }

    const id = newRunId();
    const record: RunRecord = {
      id,
      role: req.role!,
      provider: role.provider,
      model: req.model,
      startedAt: new Date().toISOString(),
      timeoutSec: req.timeoutSec ?? this.#config.defaultTimeoutSec,
      labels: req.labels,
      credHash,
      status: "running",
      branch: branchFor(id),
      cancelRequested: false,
    };
    this.#runs.set(id, record);

    ensureRunDir(this.#config.runsDir, id);
    appendEvent(this.#config.runsDir, id, "created", {
      role: record.role,
      provider: record.provider,
      model: record.model,
      branch: record.branch,
      timeoutSec: record.timeoutSec,
    });

    const supervision = this.#supervise(record, req, brief).finally(() => {
      this.#inflight.delete(supervision);
    });
    this.#inflight.add(supervision);

    return { ok: true, runId: id };
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

  async #supervise(
    record: RunRecord,
    req: RunRequest,
    brief: string,
  ): Promise<void> {
    const runsDir = this.#config.runsDir;

    let worktree: Worktree;
    try {
      worktree = await this.#worktrees.create(record.id, req.worktree?.base);
    } catch (err) {
      this.#finish(record, "error", `worktree-setup-failed: ${message(err)}`);
      return;
    }
    record.worktree = worktree;
    record.branch = worktree.branch;

    // A cancel or shutdown that arrived during setup: never start the agent.
    if (record.cancelRequested || this.#shuttingDown) {
      await this.#teardown(record);
      this.#finish(
        record,
        "error",
        record.cancelRequested ? "cancelled" : "daemon-shutdown",
      );
      return;
    }

    const role = getRole(record.role)!;
    const spec = { role: record.role, model: record.model, cwd: worktree.path };
    const command = this.#config.commandOverride
      ? this.#config.commandOverride(spec)
      : role.build(spec);

    let result: ProcResult;
    try {
      const handle = launch({
        command,
        cwd: worktree.path,
        env: childEnv(req.env ?? {}),
        stdin: brief,
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
      // cancel()/shutdown() may have fired between the flag check and here.
      if (record.cancelRequested) handle.cancel();
      else if (this.#shuttingDown) handle.shutdown();

      result = await handle.exited;
    } catch (err) {
      appendEvent(runsDir, record.id, "error", { message: message(err) });
      await this.#teardown(record);
      this.#finish(record, "error", `spawn-failed: ${message(err)}`);
      return;
    }

    const [status, summary] = classify(result, record.timeoutSec);
    await this.#teardown(record, status);
    this.#finish(record, status, summary);
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
      // The branch survives regardless; a stuck worktree is `hikyaku prune`'s.
      appendEvent(runsDir, record.id, "teardown", {
        removed: false,
        reason: message(err),
        worktree: record.worktree.path,
      });
    }
  }

  #finish(record: RunRecord, status: RunStatus, exitSummary: string): void {
    record.status = status;
    record.exitSummary = exitSummary;
    record.handle = undefined;
    appendEvent(this.#config.runsDir, record.id, "finished", {
      status,
      exitSummary,
      branch: record.branch,
    });
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
 * The agent inherits the daemon's environment plus the caller's injected vars.
 * HIKYAKU_TOKEN is stripped: the daemon's own bearer is not an agent's to hold.
 */
function childEnv(injected: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.HIKYAKU_TOKEN;
  return { ...env, ...injected };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
