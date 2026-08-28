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
 * Signal a whole process group, tolerating a group that has already gone.
 * Returns false when the group no longer exists.
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
    if (e.code === "ESRCH") return false;
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

  const terminate = (outcome: Outcome) => {
    if (settled) return;
    pending ??= outcome;
    const pid = child.pid;
    if (pid === undefined) return;
    killGroup(pid, "SIGTERM");
    // Escalate: an agent that ignores SIGTERM must not survive us.
    graceTimer = setTimeout(() => {
      if (!settled) killGroup(pid, "SIGKILL");
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

  child.on("exit", (code, signal) => {
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
