/**
 * The daemon as a real process: config loading, the bind, and the SIGTERM
 * handler that `RunStore.shutdown` hangs off. No agents run here — the
 * behaviour of shutdown WITH live runs is covered in supervision.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-daemon-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function startDaemon(overrides: Record<string, unknown> = {}) {
  const dir = tmp();
  const configPath = join(dir, "config.json");
  const port = 39_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(
    configPath,
    JSON.stringify({
      listen: { host: "127.0.0.1", port },
      maxConcurrent: 1,
      repoPath: join(dir, "repo"),
      worktreesDir: join(dir, "worktrees"),
      runsDir: join(dir, "runs"),
      ...overrides,
    }),
  );
  mkdirSync(join(dir, "runs"), { recursive: true });

  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
    env: {
      ...process.env,
      KAIROKU_DAEMON_CONFIG: configPath,
      KAIROKU_DAEMON_TOKEN: "daemon-test-token",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { proc, port, dir };
}

async function reachable(port: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/capacity`, {
        headers: { authorization: "Bearer daemon-test-token" },
      });
      if (res.ok) {
        expect(await res.json()).toEqual({ running: 0, max: 1 });
        return true;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(50);
  }
  return false;
}

describe("daemon process", () => {
  test("starts from KAIROKU_DAEMON_CONFIG and exits 0 on SIGTERM", async () => {
    const { proc, port } = await startDaemon();
    try {
      expect(await reachable(port)).toBe(true);
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      // A clean 0, not 143: the handler ran and tore down rather than the
      // process dying under the default disposition.
      expect(exitCode).toBe(0);
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
    }
  }, 20_000);

  test("refuses to start without KAIROKU_DAEMON_TOKEN", async () => {
    const dir = tmp();
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
      env: { ...process.env, KAIROKU_DAEMON_CONFIG: join(dir, "absent.json"), KAIROKU_DAEMON_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("KAIROKU_DAEMON_TOKEN");
  }, 20_000);

  test("the pre-rename env names still work, with a deprecation line each", async () => {
    const dir = tmp();
    const configPath = join(dir, "config.json");
    const port = 39_000 + Math.floor(Math.random() * 20_000);
    writeFileSync(configPath, JSON.stringify({ listen: { host: "127.0.0.1", port }, maxConcurrent: 1 }));
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
      env: { ...process.env, KAIROKU_DAEMON_CONFIG: "", KAIROKU_DAEMON_TOKEN: "", HIKYAKU_CONFIG: configPath, HIKYAKU_TOKEN: "daemon-test-token" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await reachable(port)).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("HIKYAKU_CONFIG is deprecated");
      expect(stderr).toContain("HIKYAKU_TOKEN is deprecated");
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
    }
  }, 20_000);

  test("refuses to start bound to a wildcard host", async () => {
    const { proc } = await startDaemon({ listen: { host: "0.0.0.0", port: 0 } });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("RF-006");
  }, 20_000);
});
