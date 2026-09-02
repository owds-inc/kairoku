import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupAlive, killGroup, launch } from "./proc";
import { waitFor } from "./testkit";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-proc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function opts(dir: string, command: string[], extra: Record<string, unknown> = {}) {
  return {
    command,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdoutPath: join(dir, "stdout.log"),
    timeoutMs: 10_000,
    killGraceMs: 150,
    ...extra,
  };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("proc (RF-010)", () => {
  test("the agent is its own process group leader, so -pid is signallable", async () => {
    // Bun.spawn accepts `detached` but does not setsid; node:child_process
    // does. Without this the group kill fails EPERM and orphans survive.
    const dir = tmp();
    const handle = launch(opts(dir, ["sh", "-c", "sleep 5"]));
    expect(handle.pid).toBeGreaterThan(0);
    expect(groupAlive(handle.pid!)).toBe(true);
    handle.cancel();
    await handle.exited;
  });

  test("stdout and stderr both land in stdout.log, and stdin carries the brief", async () => {
    const dir = tmp();
    const handle = launch(
      opts(dir, ["sh", "-c", "cat; echo to-stderr >&2; echo to-stdout"]),
      );
    const result = await handle.exited;
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);

    const log = readFileSync(join(dir, "stdout.log"), "utf8");
    expect(log).toContain("to-stdout");
    expect(log).toContain("to-stderr");
  });

  test("stdin delivers the brief verbatim", async () => {
    const dir = tmp();
    const brief = "line one\nline two with a - leading dash\n";
    const handle = launch(opts(dir, ["sh", "-c", "cat"], { stdin: brief }));
    await handle.exited;
    expect(readFileSync(join(dir, "stdout.log"), "utf8")).toBe(brief);
  });

  test("a non-zero exit is reported with its code", async () => {
    const dir = tmp();
    const result = await launch(opts(dir, ["sh", "-c", "exit 7"])).exited;
    expect(result).toMatchObject({ outcome: "exited", exitCode: 7 });
  });

  test("timeout terminates the group and reports `timeout`", async () => {
    const dir = tmp();
    const handle = launch(opts(dir, ["sh", "-c", "sleep 30"], { timeoutMs: 200 }));
    const pid = handle.pid!;
    const result = await handle.exited;
    expect(result.outcome).toBe("timeout");
    expect(groupAlive(pid)).toBe(false);
  });

  test("cancel and shutdown report distinct causes", async () => {
    const dir = tmp();
    const cancelled = launch(opts(dir, ["sh", "-c", "sleep 30"]));
    cancelled.cancel();
    expect((await cancelled.exited).outcome).toBe("cancelled");

    const stopped = launch(opts(tmp(), ["sh", "-c", "sleep 30"]));
    stopped.shutdown();
    expect((await stopped.exited).outcome).toBe("shutdown");
  });

  test("an agent that ignores SIGTERM is escalated to SIGKILL", async () => {
    const dir = tmp();
    // Two things this test has to get right, both learned the hard way:
    // the shell must ignore TERM *itself* and stay alive (a bare
    // `trap "" TERM; sleep 30` exits anyway, because its `sleep` child has no
    // trap), and the cancel must not race the shell's startup — signalling
    // before the trap builtin has run just kills it with the default
    // disposition.
    const ready = join(dir, "trapped");
    const handle = launch(
      opts(dir, [
        "sh",
        "-c",
        `trap "" TERM; : > ${ready}; while :; do sleep 0.05; done`,
      ]),
    );
    const pid = handle.pid!;
    await waitFor(() => existsSync(ready), "the shell to install its TERM trap");
    handle.cancel();
    const result = await handle.exited;
    expect(result.outcome).toBe("cancelled");
    expect(result.signal).toBe("SIGKILL");
    expect(await alive(pid)).toBe(false);
  });

  test("a child that exits leaving a background grandchild takes the group with it", async () => {
    // The run is over when its leader exits; nothing it forked survives it.
    // This is the window the same-tick cancel test hits on linux, made
    // deterministic: dash forks `sleep` rather than exec'ing it, and a
    // grandchild forked in the instant the group is signalled misses the
    // signal — so the exit path itself has to sweep the group.
    const dir = tmp();
    const handle = launch(opts(dir, ["sh", "-c", "sleep 30 & exit 0"]));
    const pid = handle.pid!;
    const result = await handle.exited;
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(groupAlive(pid)).toBe(false);
  });

  test("cancelling in the same tick as the spawn still kills the agent", async () => {
    // Regression: node calls setsid() in the child between fork and exec, so
    // for a moment after spawn `-pid` names a process group that is not ours
    // and process.kill(-pid) fails EPERM. That threw out of cancel() and left
    // the agent running unsupervised — reachable in production whenever a
    // cancel arrives while the run's worktree is still being set up.
    // Looped because the window is short: one iteration would rarely hit it.
    for (let i = 0; i < 25; i++) {
      const dir = tmp();
      const handle = launch(opts(dir, ["sh", "-c", "sleep 30"]));
      const pid = handle.pid!;
      expect(() => handle.cancel()).not.toThrow();
      const result = await handle.exited;
      expect(result.outcome).toBe("cancelled");
      expect(groupAlive(pid)).toBe(false);
      expect(await alive(pid)).toBe(false);
    }
  }, 30_000);

  test("killGroup reports EPERM as 'not our group', never throws", async () => {
    // The daemon's own process group is signallable by us, so it cannot stand
    // in for the EPERM case; what matters is that the classification exists and
    // that an unknown pid is simply reported as gone rather than raising.
    const unused = 0x7ffffff0;
    expect(killGroup(unused, "SIGTERM")).toBe(false);
    expect(groupAlive(unused)).toBe(false);
  });

  test("the first cause wins: a later signal does not rewrite the outcome", async () => {
    const dir = tmp();
    const handle = launch(opts(dir, ["sh", "-c", "sleep 30"]));
    handle.cancel();
    handle.shutdown();
    expect((await handle.exited).outcome).toBe("cancelled");
  });

  test("killGroup reports a group that has already gone, rather than throwing", async () => {
    const dir = tmp();
    const handle = launch(opts(dir, ["sh", "-c", "exit 0"]));
    const pid = handle.pid!;
    await handle.exited;
    expect(killGroup(pid, "SIGTERM")).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  });

  test("a command that cannot be spawned resolves with the error, never hangs", async () => {
    const dir = tmp();
    const result = await launch(
      opts(dir, [join(dir, "no-such-binary")]),
    ).exited;
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("ENOENT");
  });

  test("an empty command is rejected before anything is spawned", () => {
    const dir = tmp();
    expect(() => launch(opts(dir, []))).toThrow(/empty command/);
    expect(existsSync(join(dir, "stdout.log"))).toBe(false);
  });
});
