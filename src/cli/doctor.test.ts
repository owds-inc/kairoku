import { describe, expect, test } from "bun:test";
import { checks, run, type Check } from "./doctor";
import { fakeIo, type FakeIo } from "./testkit";

const pluginInstalled = JSON.stringify([
  { id: "kairoku@kairoku-marketplace", version: "2.2.0", scope: "user", enabled: true },
]);

function laptop(): FakeIo {
  const io = fakeIo();
  io.bins.add("claude");
  io.canned["claude --version"] = { stdout: "2.1.258 (Claude Code)\n" };
  io.canned["claude plugin list --json"] = { stdout: pluginInstalled };
  return io;
}

/** A linux VM with the daemon fully provisioned, every check PASS. */
function linuxDaemon(): FakeIo {
  const home = "/home/tester";
  const io = fakeIo({ platform: "linux", home, uid: 1000 });
  for (const b of ["node", "bun", "claude", "codex", "paseo", "git", "systemctl"]) io.bins.add(b);
  Object.assign(io.files, {
    [`${home}/.bashrc`]: `export PATH="${home}/.bun/bin:${home}/.nvm/versions/node/v24.1.0/bin:$PATH"\n# interactive guard below\n`,
    [`${home}/.bun/bin`]: "",
    [`${home}/.nvm/versions/node/v24.1.0/bin`]: "",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
    [`${home}/.codex/config.toml`]: 'bearer_token_env_var = "KAIROKU_PAT"\ndefault_tools_approval_mode = "approve"\n',
    [`${home}/.kairoku`]: "",
    [`${home}/.kairoku/config.json`]: JSON.stringify({
      listen: { host: "10.0.0.5", port: 7801 },
      appUrl: "https://app.test",
      repoPath: `${home}/work/kairoku`,
    }),
    [`${home}/.kairoku/token.env`]: "KAIROKU_DAEMON_TOKEN=secret\n",
    "/etc/systemd/system/paseo.service": "",
    [`${home}/work/kairoku/.git`]: "",
  });
  io.modes[`${home}/.kairoku/token.env`] = 0o600;
  Object.assign(io.canned, {
    "node --version": { stdout: "v24.1.0\n" },
    "bun --version": { stdout: "1.3.14\n" },
    "claude --version": { stdout: "2.1.258 (Claude Code)\n" },
    "codex --version": { stdout: "codex-cli 0.40.0\n" },
    "paseo --version": { stdout: "0.6.2\n" },
    "claude plugin list --json": { stdout: pluginInstalled },
    "systemctl is-active kairoku-daemon": { stdout: "active\n" },
    "systemctl is-enabled kairoku-daemon": { stdout: "enabled\n" },
    "systemctl is-active paseo": { stdout: "active\n" },
    [`git -C ${home}/work/kairoku rev-parse --short HEAD`]: { stdout: "abc1234\n" },
    [`git -C ${home}/work/kairoku status --porcelain`]: { stdout: "" },
  });
  io.fetch = async (url, init) => {
    // The loopback listener: no bearer, and `/status` is what doctor reads.
    if (url === "http://10.0.0.5:7801/status") {
      return Response.json({
        version: "0.1.0",
        capacity: { running: 1, max: 2 },
        link: { linked: true, appUrl: "https://app.test", liveness: "online", protocol: "1", runsInFlight: 1, pendingReports: 0 },
        runs: [{ dispatchId: "d-1", status: "running", startedAt: "t", branch: "run/d-1" }],
      });
    }
    // The app: one real heartbeat, exactly as the daemon would send it.
    if (url === "https://app.test/api/daemon/heartbeat") {
      if (new Headers(init?.headers).get("authorization") !== "Bearer secret") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({
        daemon: { id: "daemon-1", name: "vm-1" },
        liveness: "online",
        heartbeatIntervalMs: 30_000,
        protocol: "1",
        runs: [],
      });
    }
    return new Response("", { status: 404 });
  };
  return io;
}

const byName = (list: Check[], name: string) => list.find((c) => c.name === name);
const statuses = (list: Check[]) => Object.fromEntries(list.map((c) => [c.name, c.status]));

describe("kairoku doctor", () => {
  test("a laptop with only the plugin passes; the daemon section is one WARN", async () => {
    const io = laptop();
    const list = await checks(io);
    expect(statuses(list)).toEqual({
      "claude installed": "PASS",
      "kairoku plugin installed": "PASS",
      "daemon configured": "WARN",
    });
    expect(byName(list, "daemon configured")?.detail).toContain("kairoku setup --daemon");
    expect(await run([], io)).toBe(0);
  });

  test("no claude on PATH is a FAIL and the plugin check is skipped", async () => {
    const io = fakeIo();
    const list = await checks(io);
    expect(byName(list, "claude installed")?.status).toBe("FAIL");
    expect(byName(list, "kairoku plugin installed")).toBeUndefined();
    expect(await run([], io)).toBe(1);
  });

  test("a provisioned linux VM passes every check", async () => {
    const io = linuxDaemon();
    const list = await checks(io);
    expect(statuses(list)).toEqual({
      "claude installed": "PASS",
      "kairoku plugin installed": "PASS",
      "node ≥ 24": "PASS",
      "bun installed": "PASS",
      "codex installed": "PASS",
      "paseo installed": "PASS",
      "PATH export is ~/.bashrc line 1": "PASS",
      "exported dirs exist": "PASS",
      "userns unrestricted": "PASS",
      "codex MCP writes pre-approved": "PASS",
      "config.json": "PASS",
      "token.env": "PASS",
      "daemon service": "PASS",
      "daemon reachable": "PASS",
      "app link": "PASS",
      "runs in flight": "PASS",
      "paseo.service": "PASS",
      "repo present": "PASS",
      "repo clean": "PASS",
    });
    expect(byName(list, "app link")?.detail).toContain("https://app.test");
    // The protocol version is echoed when the app sends one.
    expect(byName(list, "app link")?.detail).toContain("protocol 1");
    expect(byName(list, "runs in flight")?.detail).toBe("1");
    expect(await run([], io)).toBe(0);
    expect(io.lines.some((l) => /^\s*PASS\s+daemon service/.test(l))).toBe(true);
    expect(io.lines.at(-1)).toContain("all checks passed");
  });

  test("token.env must be mode 600", async () => {
    const io = linuxDaemon();
    io.modes["/home/tester/.kairoku/token.env"] = 0o644;
    const list = await checks(io);
    expect(byName(list, "token.env")).toMatchObject({ status: "FAIL", detail: expect.stringContaining("644") });
    expect(await run([], io)).toBe(1);
    expect(io.lines.at(-1)).toContain("1 check(s) failed");
  });

  test("an absent userns sysctl key is a WARN, a restricting one a FAIL", async () => {
    const io = linuxDaemon();
    delete io.files["/proc/sys/kernel/apparmor_restrict_unprivileged_userns"];
    expect(byName(await checks(io), "userns unrestricted")?.status).toBe("WARN");
    io.files["/proc/sys/kernel/apparmor_restrict_unprivileged_userns"] = "1\n";
    expect(byName(await checks(io), "userns unrestricted")?.status).toBe("FAIL");
  });

  test("a token the app refuses is named as exactly that, without printing it", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.kairoku/token.env"] = "KAIROKU_DAEMON_TOKEN=a-stale-token\n";
    const list = await checks(io);
    const link = byName(list, "app link")!;
    expect(link.status).toBe("FAIL");
    expect(link.detail).toContain("token not accepted by https://app.test");
    expect(JSON.stringify(list)).not.toContain("a-stale-token");
    expect(await run([], io)).toBe(1);
  });

  test("no appUrl is a FAIL that names the command that fixes it", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.kairoku/config.json"] = JSON.stringify({ listen: { host: "10.0.0.5", port: 7801 } });
    const link = byName(await checks(io), "app link")!;
    expect(link.status).toBe("FAIL");
    expect(link.detail).toContain("kairoku setup --daemon");
  });

  test("a daemon that is not listening fails reachability but the app link is still checked", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) =>
      url.startsWith("http://10.0.0.5") ? Promise.reject(new Error("refused")) : app(url, init);
    const list = await checks(io);
    expect(byName(list, "daemon reachable")?.status).toBe("FAIL");
    expect(byName(list, "app link")?.status).toBe("PASS");
    expect(byName(list, "runs in flight")?.status).toBe("WARN");
  });

  test("a dirty checkout is a WARN, a missing one a FAIL", async () => {
    const io = linuxDaemon();
    io.canned["git -C /home/tester/work/kairoku status --porcelain"] = { stdout: " M a.ts\n?? b.ts\n" };
    expect(byName(await checks(io), "repo clean")).toMatchObject({ status: "WARN", detail: expect.stringContaining("2") });
    expect(await run([], io)).toBe(0);
    delete io.files["/home/tester/work/kairoku/.git"];
    expect(byName(await checks(io), "repo present")?.status).toBe("FAIL");
  });

  test("on mac the service is a launchd agent and the linux-only checks are absent", async () => {
    const io = linuxDaemon();
    io.platform = "darwin";
    io.uid = 501;
    io.canned["launchctl print gui/501/io.kairoku.daemon"] = { code: 0, stdout: "state = running\n" };
    const list = await checks(io);
    expect(byName(list, "daemon service")).toMatchObject({ status: "PASS", detail: expect.stringContaining("io.kairoku.daemon") });
    for (const linuxOnly of ["PATH export is ~/.bashrc line 1", "exported dirs exist", "userns unrestricted", "paseo.service"]) {
      expect(byName(list, linuxOnly)).toBeUndefined();
    }
    io.canned["launchctl print gui/501/io.kairoku.daemon"] = { code: 113, stderr: "Could not find service\n" };
    expect(byName(await checks(io), "daemon service")?.status).toBe("FAIL");
  });

  test("a legacy ~/.hikyaku with HIKYAKU_TOKEN still round-trips", async () => {
    const io = linuxDaemon();
    const home = "/home/tester";
    for (const f of ["", "/config.json", "/token.env"]) {
      io.files[`${home}/.hikyaku${f}`] = io.files[`${home}/.kairoku${f}`]!;
      delete io.files[`${home}/.kairoku${f}`];
    }
    io.files[`${home}/.hikyaku/token.env`] = "HIKYAKU_TOKEN=secret\n";
    io.modes[`${home}/.hikyaku/token.env`] = 0o600;
    const list = await checks(io);
    expect(byName(list, "config.json")).toMatchObject({ status: "PASS", detail: expect.stringContaining(".hikyaku") });
    expect(byName(list, "app link")?.status).toBe("PASS");
  });
});
