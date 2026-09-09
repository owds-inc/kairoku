import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_LAUNCHAGENT_INSTALL_STOP, run } from "./daemon";
import { LAUNCHD_LABEL, launchdPlist, systemdUnit } from "./service";
import { fakeIo, type FakeIo } from "./testkit";

const calls = (io: FakeIo) => io.calls.map((c) => c.join(" "));

function linux(sudo: boolean): FakeIo {
  const io = fakeIo({ platform: "linux", home: "/home/neil", execPath: "/usr/local/bin/kairoku", env: { USER: "neil" } });
  io.bins.add("node");
  io.canned["sudo -n true"] = { code: sudo ? 0 : 1 };
  return io;
}
const systemUnit = "/etc/systemd/system/kairoku-daemon.service";
const userUnit = "/home/neil/.config/systemd/user/kairoku-daemon.service";
const expectedPath = "/usr/local/bin:/home/neil/.bun/bin:/usr/bin:/bin";

describe("kairoku daemon on linux", () => {
  test("install with passwordless sudo writes the system unit through sudo, reloads and enables", async () => {
    const io = linux(true);
    expect(await run(["install"], io)).toBe(0);
    const staged = "/home/neil/.kairoku/kairoku-daemon.service";
    expect(io.files[staged]).toBe(systemdUnit({ scope: "system", execPath: "/usr/local/bin/kairoku", user: "neil", path: expectedPath }));
    expect(calls(io)).toEqual([
      "sudo -n true",
      `sudo cp ${staged} ${systemUnit}`,
      "sudo systemctl daemon-reload",
      "sudo systemctl enable --now kairoku-daemon",
    ]);
    expect(io.lines.join("\n")).toContain(`unit written to ${systemUnit}`);
  });

  test("install leaves an unchanged, active unit alone", async () => {
    const io = linux(true);
    io.files[systemUnit] = systemdUnit({ scope: "system", execPath: "/usr/local/bin/kairoku", user: "neil", path: expectedPath });
    io.canned["sudo systemctl is-active kairoku-daemon"] = { stdout: "active\n" };
    expect(await run(["install"], io)).toBe(0);
    expect(calls(io)).toEqual(["sudo -n true", "sudo systemctl is-active kairoku-daemon"]);
    expect(io.lines.join("\n")).toContain("left running");
  });

  test("install with an unchanged but inactive unit just starts it", async () => {
    const io = linux(true);
    io.files[systemUnit] = systemdUnit({ scope: "system", execPath: "/usr/local/bin/kairoku", user: "neil", path: expectedPath });
    io.canned["sudo systemctl is-active kairoku-daemon"] = { stdout: "inactive\n" };
    expect(await run(["install"], io)).toBe(0);
    expect(calls(io)).toEqual(["sudo -n true", "sudo systemctl is-active kairoku-daemon", "sudo systemctl enable --now kairoku-daemon"]);
  });

  test("install without sudo writes a user unit and says how to keep it alive", async () => {
    const io = linux(false);
    expect(await run(["install"], io)).toBe(0);
    expect(io.files[userUnit]).toBe(systemdUnit({ scope: "user", execPath: "/usr/local/bin/kairoku", user: "neil", path: expectedPath }));
    expect(calls(io)).toEqual(["sudo -n true", "systemctl --user daemon-reload", "systemctl --user enable --now kairoku-daemon"]);
    expect(io.lines.join("\n")).toContain("loginctl enable-linger neil");
  });

  test("start / stop / status use the unit that is installed", async () => {
    const io = linux(true);
    io.files[systemUnit] = "whatever";
    io.canned["sudo systemctl is-active kairoku-daemon"] = { stdout: "active\n" };
    io.canned["sudo systemctl is-enabled kairoku-daemon"] = { stdout: "enabled\n" };
    expect(await run(["start"], io)).toBe(0);
    expect(await run(["stop"], io)).toBe(0);
    expect(await run(["status"], io)).toBe(0);
    expect(calls(io)).toEqual([
      "sudo systemctl start kairoku-daemon",
      "sudo systemctl stop kairoku-daemon",
      "sudo systemctl is-active kairoku-daemon",
      "sudo systemctl is-enabled kairoku-daemon",
    ]);
    expect(io.lines.join("\n")).toContain("kairoku-daemon active, enabled");

    const user = linux(false);
    user.files[userUnit] = "whatever";
    user.canned["systemctl --user is-active kairoku-daemon"] = { stdout: "inactive\n" };
    expect(await run(["status"], user)).toBe(1);
    expect(calls(user)[0]).toBe("systemctl --user is-active kairoku-daemon");
  });
});

describe("kairoku daemon on mac", () => {
  const plistPath = `/Users/neil/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  const target = `gui/501/${LAUNCHD_LABEL}`;
  function mac(loaded: boolean): FakeIo {
    const io = fakeIo({ platform: "darwin", home: "/Users/neil", execPath: "/opt/homebrew/bin/kairoku" });
    io.canned[`launchctl print ${target}`] = loaded ? { code: 0, stdout: "\tstate = running\n" } : { code: 113, stderr: "Could not find service" };
    return io;
  }
  const rendered = () => launchdPlist({ execPath: "/opt/homebrew/bin/kairoku", home: "/Users/neil", path: "/opt/homebrew/bin:/Users/neil/.bun/bin:/usr/local/bin:/usr/bin:/bin" });

  test("install refuses io.kairoku.daemon — Rust kairokud owns the label", async () => {
    const io = mac(false);
    expect(await run(["install"], io)).toBe(1);
    expect(io.files[plistPath]).toBeUndefined();
    expect(calls(io)).toEqual([]);
    expect(io.errors.join("\n")).toBe(MAC_LAUNCHAGENT_INSTALL_STOP);
    expect(io.errors.join("\n")).toContain("scripts/install.sh");
    expect(io.errors.join("\n")).toContain("kairokud");
  });

  test("install does not overwrite an existing plist (Rust or foreign)", async () => {
    const io = mac(true);
    io.files[plistPath] = "rust kairokud owns this";
    expect(await run(["install"], io)).toBe(1);
    expect(io.files[plistPath]).toBe("rust kairokud owns this");
    expect(calls(io)).toEqual([]);
    expect(io.errors.join("\n")).toContain("does not install or overwrite");
  });

  test("start bootstraps when unloaded, kickstarts when loaded; stop boots out; status prints the state", async () => {
    const io = mac(false);
    io.files[plistPath] = rendered();
    expect(await run(["start"], io)).toBe(0);
    io.canned[`launchctl print ${target}`] = { code: 0, stdout: "\tstate = running\n" };
    expect(await run(["start"], io)).toBe(0);
    expect(await run(["stop"], io)).toBe(0);
    expect(await run(["status"], io)).toBe(0);
    expect(calls(io)).toEqual([
      `launchctl print ${target}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
      `launchctl print ${target}`,
      `launchctl kickstart -k ${target}`,
      `launchctl bootout ${target}`,
      `launchctl print ${target}`,
    ]);
    expect(io.lines.join("\n")).toContain("state = running");
  });

  test("start without an installed agent points at kairokud install", async () => {
    const io = mac(false);
    expect(await run(["start"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("install via kairokud");
    expect(io.errors.join("\n")).not.toContain("kairoku daemon install");
  });
});

describe("kairoku daemon verbs", () => {
  test("an unknown verb prints usage and exits 2", async () => {
    const io = fakeIo();
    expect(await run(["frob"], io)).toBe(2);
    expect(io.errors.join("\n")).toContain("kairoku daemon [install|start|stop|status|prune]");
  });
});

describe("kairoku daemon in the foreground", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const main = join(import.meta.dir, "main.ts");

  test("serves the SPEC routes from KAIROKU_DAEMON_CONFIG and exits 0 on SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-cli-daemon-"));
    dirs.push(dir);
    const port = 39_000 + Math.floor(Math.random() * 20_000);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ listen: { host: "127.0.0.1", port }, maxConcurrent: 1, repoPath: join(dir, "repo"), worktreesDir: join(dir, "wt"), runsDir: join(dir, "runs") }));
    mkdirSync(join(dir, "runs"));
    writeFileSync(join(dir, "token.env"), "KAIROKU_DAEMON_TOKEN=cli-daemon-token\n");
    const proc = Bun.spawn(["bun", "run", main, "daemon"], {
      env: { ...process.env, KAIROKU_DAEMON_CONFIG: configPath, KAIROKU_DAEMON_TOKEN: "", HIKYAKU_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 8_000;
      let ok = false;
      while (Date.now() < deadline && !ok) {
        try {
          // No bearer: the loopback listener has no inbound credential (SPEC v1).
          const res = await fetch(`http://127.0.0.1:${port}/capacity`);
          ok = res.ok && JSON.stringify(await res.json()) === '{"running":0,"max":1}';
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(ok).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
    }
  }, 20_000);

  test("a config bound to a wildcard host still refuses to start (RF-006)", async () => {
    // The listener is unauthenticated now, so the bind is the whole boundary.
    const dir = mkdtempSync(join(tmpdir(), "kairoku-cli-daemon-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ listen: { host: "0.0.0.0", port: 0 } }));
    const proc = Bun.spawn(["bun", "run", main, "daemon"], {
      env: { ...process.env, KAIROKU_DAEMON_CONFIG: configPath, KAIROKU_DAEMON_TOKEN: "", HIKYAKU_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("RF-006");
  }, 20_000);
});
