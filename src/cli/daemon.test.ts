import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { MAC_LAUNCHAGENT_INSTALL_STOP, run, usage } from "./daemon";
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
    expect(io.errors.join("\n")).toContain("kairoku daemon [install|start|stop|status|drain|update|prune|migrate]");
  });
});

describe("FRV09 facade gating", () => {
  const rustInstall = {
    schemaVersion: 1 as const,
    installationId: "inst-1",
    dataRoot: "/home/neil/.local/share/kairokud",
    profile: "linux-personal" as const,
    executionUser: "neil",
    executable: "/usr/bin/kairokud",
    service: {
      manager: "systemd" as const,
      scope: "user" as const,
      label: "io.kairoku.daemon",
      package: "direct" as const,
    },
  };

  function withRustAndBun(io: FakeIo): FakeIo {
    io.bins.add("kairokud");
    io.canned["/usr/bin/kairokud instance --json"] = { stdout: JSON.stringify(rustInstall) };
    io.files["/home/neil/.kairoku/config.json"] = JSON.stringify({ listen: { host: "127.0.0.1", port: 7801 } });
    io.files["/home/neil/.kairoku/token.env"] = "KAIROKU_DAEMON_TOKEN=legacy\n";
    io.files["/home/neil/.config/systemd/user/kairoku-daemon.service"] = "[Unit]\n";
    return io;
  }

  test("Rust metadata with Bun predecessor does not route install to Rust", async () => {
    const io = withRustAndBun(fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } }));
    expect(await run(["install"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("legacy predecessor");
    expect(calls(io).some((c) => c.includes("enable --now io.kairoku.daemon"))).toBe(false);
  });

  test("completed handoff admits Rust lifecycle", async () => {
    const io = withRustAndBun(fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } }));
    io.files["/home/neil/.kairoku/migration-receipt.json"] = JSON.stringify({
      schemaVersion: 1,
      state: "complete",
      blockers: [],
      oldOwners: [],
      newOwners: [],
      serviceLabels: [],
      unresolved: [],
      dispositioned: [],
    });
    io.canned["systemctl --user enable --now io.kairoku.daemon"] = { code: 0 };
    expect(await run(["install"], io)).toBe(0);
    expect(calls(io)).toContain("systemctl --user enable --now io.kairoku.daemon");
  });

  test("drain with dual-runtime targets Bun predecessor not kairokud", async () => {
    const io = withRustAndBun(fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } }));
    const token = "a".repeat(64);
    io.files["/home/neil/.kairoku/drain.token"] = `${token}\n`;
    io.modes["/home/neil/.kairoku"] = 0o700;
    io.modes["/home/neil/.kairoku/drain.token"] = 0o600;
    const fetched: string[] = [];
    io.fetch = async (url) => {
      fetched.push(url);
      return Response.json({ local: "draining", cloud: "pending", activeAttempts: 0, pendingReports: 0 });
    };
    expect(await run(["drain"], io)).toBe(0);
    expect(fetched).toEqual(["http://127.0.0.1:7801/drain"]);
    expect(calls(io).join(" ")).not.toContain("kairokud drain");
  });

  test("migrate --cutover is reachable and documented", async () => {
    const io = withRustAndBun(fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } }));
    io.modes["/home/neil/.kairoku"] = 0o700;
    io.files["/home/neil/.kairoku/drain.token"] = `${"b".repeat(64)}\n`;
    io.modes["/home/neil/.kairoku/drain.token"] = 0o600;
    io.fetch = async (url) => {
      if (String(url).endsWith("/drain")) {
        return Response.json({ local: "draining", cloud: "pending", activeAttempts: 0, pendingReports: 0, claimsInFlight: 0 });
      }
      return Response.json({
        capacity: { running: 0, max: 2 },
        runs: [],
        link: { linked: true, pendingReports: 0, claimsInFlight: 0 },
      });
    };
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    io.canned["/usr/bin/kairokud status --json"] = {
      stdout: JSON.stringify({
        installationId: "inst-1",
        dataRoot: rustInstall.dataRoot,
        daemonId: "daemon-1",
        ownerId: "owner-1",
        processInstanceId: "process-1",
        backendUrl: "https://app.kairoku.dev",
        heartbeatOk: true,
        service: { running: true },
      }),
    };
    io.canned["/usr/bin/kairokud call system.recoveryDecide --params"] = {
      stdout: JSON.stringify({
        released: true,
        operationId: "migration-inst-1",
        purpose: "migration",
        previousRevision: 2,
        appliedRevision: 3,
        claimsInhibited: false,
      }),
    };
    expect(await run(["migrate", "--cutover"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain('"state":"complete"');
    expect(usage).toContain("migrate");
    expect(usage).toContain("--cutover");
  });
});

describe("kairoku daemon drain", () => {
  test("legacy path POSTs /drain with drain.token and never logs the credential", async () => {
    const home = "/home/neil/.kairoku";
    const token = "a".repeat(64);
    const io = fakeIo({ platform: "linux", home: "/home/neil", execPath: "/usr/local/bin/kairoku" });
    io.files[`${home}/config.json`] = JSON.stringify({ listen: { host: "127.0.0.1", port: 7801 } });
    io.files[`${home}/drain.token`] = `${token}\n`;
    io.modes[home] = 0o700;
    io.modes[`${home}/drain.token`] = 0o600;
    const fetched: Array<{ url: string; auth?: string }> = [];
    io.fetch = async (url, init) => {
      fetched.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return Response.json({ local: "draining", cloud: "pending", activeAttempts: 0, pendingReports: 1 });
    };
    expect(await run(["drain"], io)).toBe(0);
    expect(fetched).toEqual([{ url: "http://127.0.0.1:7801/drain", auth: `Bearer ${token}` }]);
    expect(io.lines.join("\n")).toContain('"local":"draining"');
    expect(io.lines.join("\n")).not.toContain(token);
    expect(io.errors.join("\n")).not.toContain(token);
    expect(calls(io).join(" ")).not.toContain(token);
  });

  test("resolved Rust installation delegates to kairokud drain --json", async () => {
    const io = fakeIo({ platform: "darwin", home: "/Users/neil", execPath: "/opt/homebrew/bin/kairoku" });
    io.bins.add("kairokud");
    io.canned["/usr/bin/kairokud instance --json"] = {
      stdout: JSON.stringify({
        schemaVersion: 1,
        installationId: "inst-1",
        dataRoot: "/Users/neil/.local/share/kairokud",
        profile: "macos-personal",
        executionUser: "neil",
        executable: "/usr/bin/kairokud",
        service: { manager: "launchd", scope: "user", label: "io.kairoku.daemon", package: "homebrew" },
      }),
    };
    io.canned["/usr/bin/kairokud drain --json"] = {
      stdout: JSON.stringify({ local: "draining", cloud: "pending", activeAttempts: 0, pendingReports: 0 }),
    };
    expect(await run(["drain"], io)).toBe(0);
    expect(calls(io)).toEqual(["/usr/bin/kairokud instance --json", "/usr/bin/kairokud drain --json"]);
    expect(io.lines.join("\n")).toContain('"local":"draining"');
  });

  test("unsafe drain.token is refused without calling fetch", async () => {
    const home = "/home/neil/.kairoku";
    const io = fakeIo({ platform: "linux", home: "/home/neil" });
    io.files[`${home}/config.json`] = JSON.stringify({ listen: { host: "127.0.0.1", port: 7801 } });
    io.files[`${home}/drain.token`] = `${"b".repeat(64)}\n`;
    io.modes[home] = 0o700;
    io.modes[`${home}/drain.token`] = 0o644;
    let fetched = 0;
    io.fetch = async () => {
      fetched += 1;
      return new Response("nope", { status: 500 });
    };
    expect(await run(["drain"], io)).toBe(1);
    expect(fetched).toBe(0);
    expect(io.errors.join("\n")).toContain("drain.token missing or unsafe");
  });
});

describe("kairoku daemon via resolved Rust installation", () => {
  const rustInstall = {
    schemaVersion: 1 as const,
    installationId: "inst-1",
    dataRoot: "/Users/neil/.local/share/kairokud",
    profile: "macos-personal" as const,
    executionUser: "neil",
    executable: "/usr/bin/kairokud",
    service: {
      manager: "launchd" as const,
      scope: "user" as const,
      label: "io.kairoku.daemon",
      package: "homebrew" as const,
    },
  };

  function withRust(io: FakeIo): FakeIo {
    io.bins.add("kairokud");
    io.canned["/usr/bin/kairokud instance --json"] = { stdout: JSON.stringify(rustInstall) };
    return io;
  }

  test("install bootstraps the recorded launchd label when the plist exists", async () => {
    const io = withRust(fakeIo({ platform: "darwin", home: "/Users/neil", uid: 501 }));
    const plist = `/Users/neil/Library/LaunchAgents/${rustInstall.service.label}.plist`;
    io.files[plist] = "rust";
    io.canned[`launchctl print gui/501/${rustInstall.service.label}`] = { code: 113 };
    expect(await run(["install"], io)).toBe(0);
    expect(calls(io)).toEqual([
      "/usr/bin/kairokud instance --json",
      `launchctl print gui/501/${rustInstall.service.label}`,
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
  });

  test("update delegates to system.requestUpdate without a second updater", async () => {
    const io = withRust(fakeIo({ platform: "darwin", home: "/Users/neil" }));
    io.canned['/usr/bin/kairokud call system.requestUpdate --params {}'] = {
      stdout: JSON.stringify({ ok: true }),
    };
    expect(await run(["update"], io)).toBe(0);
    expect(calls(io)).toEqual([
      "/usr/bin/kairokud instance --json",
      "/usr/bin/kairokud call system.requestUpdate --params {}",
    ]);
  });

  test("prune refuses the Rust data root", async () => {
    const io = withRust(fakeIo({ platform: "darwin", home: "/Users/neil" }));
    expect(await run(["prune"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("blocked pending deletion-policy review");
    expect(io.errors.join("\n")).toContain(rustInstall.dataRoot);
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
    const bunBin = Bun.which("bun") ?? "bun";
    const bunDir = dirname(bunBin);
    const proc = Bun.spawn([bunBin, "run", main, "daemon"], {
      // Keep kairokud off PATH so this Bun listener fixture is not diverted to Rust.
      env: {
        ...process.env,
        PATH: `${bunDir}:/usr/bin:/bin`,
        KAIROKU_DAEMON_CONFIG: configPath,
        KAIROKU_DAEMON_TOKEN: "",
        HIKYAKU_TOKEN: "",
      },
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
    const bunBin = Bun.which("bun") ?? "bun";
    const bunDir = dirname(bunBin);
    const proc = Bun.spawn([bunBin, "run", main, "daemon"], {
      env: {
        ...process.env,
        PATH: `${bunDir}:/usr/bin:/bin`,
        KAIROKU_DAEMON_CONFIG: configPath,
        KAIROKU_DAEMON_TOKEN: "",
        HIKYAKU_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("RF-006");
  }, 20_000);
});
