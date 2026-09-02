/**
 * RF-010 — process supervision.
 *
 * Agents run in their OWN process group so that kill is group-wide and leaves
 * no orphans. This is why the module uses `node:child_process` rather than
 * `Bun.spawn`: Bun.spawn accepts a `detached` option but does not call setsid,
 * so the child stays in the daemon's group and `process.kill(-pid, …)` fails
 * with EPERM. Verified against bun 1.3.14 before this was written.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export type Outcome = "exited" | "timeout" | "cancelled" | "shutdown";

export interface ProcResult {
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Set when the process could not be spawned at all. */
  readonly error?: string;
}

export interface ProcHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<ProcResult>;
  /** RF-004 — group kill, reported as `cancelled`. */
  cancel(): void;
  /** RF-010 — group kill on daemon SIGTERM, reported as `shutdown`. */
  shutdown(): void;
}

export interface LaunchOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Written to the child's stdin, then stdin is closed. */
  readonly stdin?: string;
  /** stdout and stderr are both appended here. */
  readonly stdoutPath: string;
  readonly timeoutMs: number;
  /** Grace between SIGTERM and SIGKILL on a group kill. */
  readonly killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Signal a whole process group. Returns false when the signal did not land.
 *
 * Two failures are expected rather than exceptional, and both mean "there is no
 * group of ours to signal":
 *
 * - ESRCH — the group is gone; the run already exited.
 * - EPERM — `-pid` names a group we may not signal. This is the setsid window:
 *   node calls setsid() in the child between fork and exec, so for a moment
 *   after spawn the child is NOT yet its own group leader and `pid` refers to
 *   some other process group entirely. Callers must fall back to signalling the
 *   child directly, which is always correct — and sufficient, because inside
 *   that window the child has not exec'd the agent yet and therefore has no
 *   descendants to reap.
 */
export function killGroup(
  pid: number,
  signal: NodeJS.Signals | number,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH" || e.code === "EPERM") return false;
    throw err;
  }
}

/** True while any process in the group is still alive. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function launch(opts: LaunchOptions): ProcHandle {
  const [file, ...args] = opts.command;
  if (!file) throw new Error("launch: empty command");

  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const fd = openSync(opts.stdoutPath, "a");

  let child;
  try {
    child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      // setsid: the child becomes a process-group leader, so -pid reaches the
      // agent and everything it spawns.
      detached: true,
      stdio: ["pipe", fd, fd],
    });
  } catch (err) {
    closeSync(fd);
    throw err;
  }

  /** Set by cancel/shutdown/timeout so the exit handler reports the cause. */
  let pending: Outcome | null = null;
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  let resolve!: (r: ProcResult) => void;
  const exited = new Promise<ProcResult>((r) => {
    resolve = r;
  });

  const settle = (result: ProcResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    resolve(result);
  };

  /**
   * Signal the run: the whole group where we have one, and always the child
   * itself. The direct kill is the fallback for the setsid window described on
   * killGroup — without it, a cancel arriving in the moments after spawn threw
   * EPERM and left the agent running with nobody supervising it.
   */
  const signalRun = (signal: NodeJS.Signals) => {
    const pid = child.pid;
    if (pid === undefined) return;
    killGroup(pid, signal);
    try {
      child.kill(signal);
    } catch {
      // Already gone. The exit handler settles the run.
    }
  };

  let terminating = false;
  const terminate = (outcome: Outcome) => {
    if (settled) return;
    pending ??= outcome;
    if (terminating) return;
    terminating = true;
    signalRun("SIGTERM");
    // Escalate: an agent that ignores SIGTERM must not survive us.
    graceTimer = setTimeout(() => {
      if (!settled) signalRun("SIGKILL");
    }, graceMs);
    graceTimer.unref?.();
  };

  const timeoutTimer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
  timeoutTimer.unref?.();

  child.on("error", (err) => {
    settle({
      outcome: pending ?? "exited",
      exitCode: null,
      signal: null,
      error: err.message,
    });
  });

  child.on("exit", async (code, signal) => {
    // The run is over; nothing it forked survives it. A grandchild forked in
    // the instant the group was signalled missed that signal (seen on linux,
    // where sh forks `sleep` rather than exec'ing it), and an agent that exits
    // cleanly may leave a background process behind — either way the worktree
    // is about to be torn down from under it. Sweep the group and wait for it
    // to be gone, so `exited` means the whole run is gone.
    const pid = child.pid;
    if (pid !== undefined && groupAlive(pid)) {
      killGroup(pid, "SIGKILL");
      const deadline = Date.now() + graceMs;
      while (groupAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    settle({
      outcome: pending ?? "exited",
      exitCode: code,
      signal: signal ?? null,
    });
  });

  if (opts.stdin !== undefined) {
    child.stdin?.on("error", () => {
      // A child that exits before reading its brief closes the pipe; EPIPE here
      // is the child's problem, reported through its exit code, not ours.
    });
    child.stdin?.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  return {
    pid: child.pid,
    exited,
    cancel: () => terminate("cancelled"),
    shutdown: () => terminate("shutdown"),
  };
}
