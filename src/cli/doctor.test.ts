import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checks, kairokudRpc, run, type Check } from "./doctor";
import { fakeIo, type FakeIo } from "./testkit";

/** A directory registration left behind by a repo move — the shape cli-4 measured on a real machine. */
const STALE_MARKETPLACE_DIR = "/old/kairoku-marketplace";

const PLUGIN_PATH = "/home/tester/.claude/plugins/cache/kairoku-marketplace/kairoku/2.2.0";
const marketplaceRegistered = JSON.stringify([
  { name: "kairoku-marketplace", source: "github", repo: "owds-inc/kairoku", installLocation: "/home/tester/.claude/plugins/marketplaces/kairoku-marketplace" },
]);
const pluginInstalled = JSON.stringify([
  { id: "kairoku@kairoku-marketplace", version: "2.2.0", scope: "user", enabled: true, installPath: PLUGIN_PATH },
]);
/** What `exists` has to see for a candidate to count as a plugin. */
const PLUGIN_MANIFEST = `${PLUGIN_PATH}/.claude-plugin/plugin.json`;

function laptop(): FakeIo {
  const io = fakeIo({ home: "/home/tester" });
  io.files[PLUGIN_MANIFEST] = '{"name":"kairoku"}';
  io.bins.add("claude");
  io.canned["claude --version"] = { stdout: "2.1.258 (Claude Code)\n" };
  io.canned["claude plugin list --json"] = { stdout: pluginInstalled };
  io.canned["claude plugin marketplace list --json"] = { stdout: marketplaceRegistered };
  return io;
}

/** A linux VM with the daemon fully provisioned, every check PASS. */
function linuxDaemon(): FakeIo {
  const home = "/home/tester";
  const io = fakeIo({ platform: "linux", home, uid: 1000 });
  for (const b of ["node", "bun", "claude", "codex", "paseo", "git", "systemctl", "docker", "op", "ast-grep", "typescript-language-server", "codegraph"]) io.bins.add(b);
  Object.assign(io.files, {
    [`${home}/.bashrc`]: `export PATH="${home}/.bun/bin:${home}/.nvm/versions/node/v24.1.0/bin:$PATH"\n# interactive guard below\n`,
    [`${home}/.bun/bin`]: "",
    [`${home}/.nvm/versions/node/v24.1.0/bin`]: "",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
    [`${home}/.codex/config.toml`]: '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\n',
    [`${home}/.kairoku`]: "",
    [`${home}/.kairoku/config.json`]: JSON.stringify({
      listen: { host: "10.0.0.5", port: 7801 },
      appUrl: "https://app.test",
      repoPath: `${home}/work/kairoku`,
    }),
    [`${home}/.kairoku/token.env`]: "KAIROKU_DAEMON_TOKEN=secret\n",
    "/etc/systemd/system/paseo.service": "",
    [`${home}/work/kairoku/.git`]: "",
    [PLUGIN_MANIFEST]: '{"name":"kairoku"}',
  });
  io.modes[`${home}/.kairoku/token.env`] = 0o600;
  Object.assign(io.canned, {
    "node --version": { stdout: "v24.1.0\n" },
    "bun --version": { stdout: "1.3.14\n" },
    "claude --version": { stdout: "2.1.258 (Claude Code)\n" },
    "codex --version": { stdout: "codex-cli 0.40.0\n" },
    "paseo --version": { stdout: "0.6.2\n" },
    "claude plugin list --json": { stdout: pluginInstalled },
    "claude plugin marketplace list --json": { stdout: marketplaceRegistered },
    "systemctl is-active kairoku-daemon": { stdout: "active\n" },
    "systemctl is-enabled kairoku-daemon": { stdout: "enabled\n" },
    "systemctl is-active paseo": { stdout: "active\n" },
    [`git -C ${home}/work/kairoku rev-parse --short HEAD`]: { stdout: "abc1234\n" },
    [`git -C ${home}/work/kairoku status --porcelain`]: { stdout: "" },
    "docker compose version": { stdout: "Docker Compose version v5.4.0\n" },
    "ast-grep --version": { stdout: "ast-grep 0.45.2\n" },
    "typescript-language-server --version": { stdout: "5.1.0\n" },
    "codegraph --version": { stdout: "1.0.1\n" },
    [`git -C ${home}/work/kairoku ls-tree -r --name-only origin/main -- .kairoku/rules`]: {
      stdout: ".kairoku/rules/bun-spawn-resolved-path.yml\n.kairoku/rules/compose-loopback-ports.yml\n",
    },
    [`git -C ${home}/work/kairoku show origin/main:kairoku.json`]: {
      stdout: JSON.stringify({ env: { test: { compose: "compose.test.yml" } }, test: "bun test" }),
    },
  });
  io.fetch = async (url, init) => {
    // The loopback listener: no bearer, and `/status` is what doctor reads.
    if (url === "http://10.0.0.5:7801/status") {
      return Response.json({
        version: "0.1.0",
        capacity: { running: 1, max: 2 },
        link: { linked: true, appUrl: "https://app.test", liveness: "online", protocol: "1", runsInFlight: 1, pendingReports: 0 },
        runs: [{ dispatchId: "d-1", status: "running", startedAt: "t", branch: "run/d-1" }],
        // Q14 — healthy Slack section so the full-VM suite stays all-PASS.
        slack: { entryId: "slack", status: "connected", teamName: "Acme Workspace", hasCredential: true },
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
  test("a laptop with only the plugin passes; the desktop and daemon sections WARN", async () => {
    const io = laptop();
    const list = await checks(io);
    expect(statuses(list)).toEqual({
      "claude installed": "PASS",
      "kairoku plugin installed": "PASS",
      "kairoku marketplace source": "PASS",
      "kairoku plugin path": "PASS",
      "desktop daemon (kairokud)": "WARN",
      "daemon configured": "WARN",
    });
    expect(byName(list, "daemon configured")?.detail).toContain("kairoku setup --daemon");
    expect(await run([], io)).toBe(0);
  });

  test("a stale marketplace source FAILs with a manual re-point and changes nothing", async () => {
    for (const source of [
      { source: "github", repo: "bikerwhocodes/kairoku" },
      { source: "directory", path: STALE_MARKETPLACE_DIR },
    ]) {
      const io = laptop();
      io.canned["claude plugin marketplace list --json"] = {
        stdout: JSON.stringify([{ name: "kairoku-marketplace", ...source, installLocation: "/old/marketplace" }]),
      };
      const before = JSON.stringify(io.files);
      const check = byName(await checks(io), "kairoku marketplace source");
      expect(check?.status).toBe("FAIL");
      expect(check?.detail).toContain("claude plugin marketplace remove kairoku-marketplace");
      expect(check?.detail).toContain("kairoku plugin install");
      expect(await run([], io)).toBe(1);
      expect(io.calls.filter((args) => args.slice(0, 3).join(" ") === "claude plugin marketplace"))
        .toEqual(Array(2).fill(["claude", "plugin", "marketplace", "list", "--json"]));
      expect(JSON.stringify(io.files)).toBe(before);
    }
  });

  test("the canonical GitHub marketplace source passes", async () => {
    const check = byName(await checks(laptop()), "kairoku marketplace source");
    expect(check?.status).toBe("PASS");
    expect(check?.detail).toContain("owds-inc/kairoku");
  });

  test("an absent marketplace FAILs with the install command", async () => {
    const io = laptop();
    io.canned["claude plugin marketplace list --json"] = { stdout: "[]" };
    const check = byName(await checks(io), "kairoku marketplace source");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("kairoku plugin install");
  });

  test("unavailable or malformed marketplace output WARNs without guessing", async () => {
    for (const reply of [{ code: 1, stdout: marketplaceRegistered }, { stdout: "not json" }, { stdout: "{}" }, { stdout: "[null]" }]) {
      const io = laptop();
      io.canned["claude plugin marketplace list --json"] = reply;
      const check = byName(await checks(io), "kairoku marketplace source");
      expect(check?.status).toBe("WARN");
      expect(check?.detail).toContain("claude plugin marketplace list --json");
    }
  });

  test("missing marketplace source fields WARN instead of claiming a wrong source", async () => {
    for (const source of [{}, { source: "github" }]) {
      const io = laptop();
      io.canned["claude plugin marketplace list --json"] = {
        stdout: JSON.stringify([{ name: "kairoku-marketplace", ...source }]),
      };
      expect(byName(await checks(io), "kairoku marketplace source")?.status).toBe("WARN");
    }
  });

  test("doctor names the plugin directory the daemon will hand the SDK, and FAILs closed without one", async () => {
    // `PASS kairoku plugin installed` was true on a machine where every Claude
    // run refused: installed says the marketplace registered it, this says the
    // daemon can find it. The two came apart, so they are now two lines.
    const io = laptop();
    expect(byName(await checks(io), "kairoku plugin path")?.detail).toBe(PLUGIN_PATH);

    const missing = laptop();
    delete missing.files[PLUGIN_MANIFEST];
    const check = byName(await checks(missing), "kairoku plugin path");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("kairoku plugin install");
  });

  test("a pluginPath in config.json is what doctor reports — and only while it still exists", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.kairoku/config.json"] = JSON.stringify({
      listen: { host: "10.0.0.5", port: 7801 },
      appUrl: "https://app.test",
      repoPath: "/home/tester/work/kairoku",
      pluginPath: "/opt/kairoku/plugin",
    });
    io.files["/opt/kairoku/plugin/.claude-plugin/plugin.json"] = "{}";
    expect(byName(await checks(io), "kairoku plugin path")?.detail).toBe("/opt/kairoku/plugin");

    delete io.files["/opt/kairoku/plugin/.claude-plugin/plugin.json"];
    expect(byName(await checks(io), "kairoku plugin path")?.detail).toBe(PLUGIN_PATH);
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
    const list = await checks(io, { probe: () => true });
    expect(statuses(list)).toEqual({
      "claude installed": "PASS",
      "kairoku plugin installed": "PASS",
      "kairoku marketplace source": "PASS",
      "kairoku plugin path": "PASS",
      "node ≥ 24": "PASS",
      "bun installed": "PASS",
      "codex installed": "PASS",
      "paseo installed": "PASS",
      "PATH export is ~/.bashrc line 1": "PASS",
      "exported dirs exist": "PASS",
      "userns unrestricted": "PASS",
      "codex MCP is a human login": "PASS",
      "config.json": "PASS",
      "token.env": "PASS",
      "daemon service": "PASS",
      "desktop daemon (kairokud)": "WARN",
      "daemon reachable": "PASS",
      "app link": "PASS",
      "runs in flight": "PASS",
      "link errors": "PASS",
      "slack connection": "PASS",
      "paseo.service": "PASS",
      "repo present": "PASS",
      "docker compose": "PASS",
      "run port range": "PASS",
      "kairoku.json": "PASS",
      "ast-grep": "PASS",
      "rules on base branch": "PASS",
      "typescript-language-server": "PASS",
      codegraph: "PASS",
      "secret resolvers": "PASS",
      "repo clean": "PASS",
    });
    expect(byName(list, "app link")?.detail).toContain("https://app.test");
    // The protocol version is echoed when the app sends one.
    expect(byName(list, "app link")?.detail).toContain("protocol 1");
    // §23.2 — the curated-events cadence, off the heartbeat entirely.
    expect(byName(list, "app link")?.detail).toContain("events flush: 2 s while active");
    expect(byName(list, "runs in flight")?.detail).toBe("1");
    expect(byName(list, "link errors")?.detail).toBe("none");
    expect(byName(list, "slack connection")?.detail).toContain("Acme Workspace");
    // The one WARN: a headless runner carries no desktop daemon, and that is fine.
    expect(byName(list, "desktop daemon (kairokud)")?.detail).toContain("not running");
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

  test("a successful heartbeat still reports the refused run verbatim", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      const response = await app(url, init);
      if (!url.endsWith("/status")) return response;
      const status = await response.json();
      status.link.lastError = "run r-1 of d-1: counts refused";
      return Response.json(status);
    };
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "app link")?.status).toBe("PASS");
    expect(byName(list, "link errors")?.detail).toContain("r-1");
    expect(byName(list, "link errors")).toEqual({
      name: "link errors", status: "WARN", detail: "run r-1 of d-1: counts refused",
    });
    expect(await run([], io)).toBe(0);
    expect(io.lines.some((line) => line.includes("WARN  link errors") && line.endsWith("run r-1 of d-1: counts refused"))).toBe(true);
  });

  test("a successful heartbeat does not hide a stopped daemon link", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      const response = await app(url, init);
      if (!url.endsWith("/status")) return response;
      const status = await response.json();
      status.link.stopped = "token-rejected";
      status.link.lastError = "token not accepted by https://app.test";
      return Response.json(status);
    };
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "app link")?.status).toBe("PASS");
    expect(byName(list, "link errors")).toEqual({
      name: "link errors", status: "FAIL",
      detail: "stopped: token-rejected — token not accepted by https://app.test",
    });
    expect(await run([], io)).toBe(1);
  });

  test("a failing heartbeat retains one link errors check after runs in flight", async () => {
    for (const [link, expected] of [
      [{ lastError: "run r-1 of d-1: counts refused" }, { status: "WARN", detail: "run r-1 of d-1: counts refused" }],
      [{ stopped: "token-rejected", lastError: "token not accepted by https://app.test" },
        { status: "FAIL", detail: "stopped: token-rejected — token not accepted by https://app.test" }],
      [undefined, { status: "PASS", detail: "none" }],
    ] as const) {
      const io = linuxDaemon();
      const app = io.fetch;
      io.fetch = async (url, init) => {
        if (url.endsWith("/heartbeat")) return new Response(null, { status: 503 });
        const response = await app(url, init);
        const status = await response.json();
        status.link = link;
        return Response.json(status);
      };
      const list = await checks(io, { probe: () => true });
      expect(byName(list, "app link")?.status).toBe("FAIL");
      expect(list.filter((check) => check.name === "link errors")).toEqual([{ name: "link errors", ...expected }]);
      expect(list[list.findIndex((check) => check.name === "runs in flight") + 1]?.name).toBe("link errors");
    }
  });

  test("a daemon that is not listening fails reachability but the app link is still checked", async () => {
    for (const heartbeatOk of [true, false]) {
      const io = linuxDaemon();
      const app = io.fetch;
      io.fetch = async (url, init) => {
        if (url.startsWith("http://10.0.0.5")) throw new Error("refused");
        return heartbeatOk ? app(url, init) : new Response(null, { status: 503 });
      };
      const list = await checks(io, { probe: () => true });
      expect(byName(list, "daemon reachable")?.status).toBe("FAIL");
      expect(byName(list, "app link")?.status).toBe(heartbeatOk ? "PASS" : "FAIL");
      expect(byName(list, "runs in flight")?.status).toBe("WARN");
      expect(byName(list, "link errors")).toEqual({
        name: "link errors", status: "WARN", detail: "unknown — the daemon is not answering",
      });
    }
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

  // ------------------------------------------------------------ O-4: environments

  /** Never bind a real port from a unit test. */
  const freeProbe = { probe: () => true };

  test("O-4: docker, the port range, the repo's manifest and the resolvers are all reported", async () => {
    const io = linuxDaemon();
    const list = await checks(io, freeProbe);
    expect(byName(list, "docker compose")?.status).toBe("PASS");
    expect(byName(list, "docker compose")?.detail).toContain("v5.4.0");
    expect(byName(list, "run port range")?.status).toBe("PASS");
    expect(byName(list, "run port range")?.detail).toContain("20000-29999");
    expect(byName(list, "kairoku.json")?.status).toBe("PASS");
    expect(byName(list, "kairoku.json")?.detail).toContain("test");
    expect(byName(list, "secret resolvers")?.status).toBe("PASS");
    expect(byName(list, "secret resolvers")?.detail).toContain("op");
  });

  test("O-4: no docker is a WARN, not a FAIL — a repo with no compose profile still runs here", async () => {
    const io = linuxDaemon();
    io.bins.delete("docker");
    const check = byName(await checks(io, freeProbe), "docker compose");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("compose");
    expect(await run([], io)).toBe(0);
  });

  test("O-4: docker installed but not RUNNING is a FAIL — that is a machine that will fail every run", async () => {
    const io = linuxDaemon();
    io.canned["docker compose version"] = { code: 1, stderr: "Cannot connect to the Docker daemon" };
    expect(byName(await checks(io, freeProbe), "docker compose")?.status).toBe("FAIL");
  });

  test("O-4: a range with nothing free is a FAIL, and it names the range", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.kairoku/config.json"] = JSON.stringify({
      listen: { host: "10.0.0.5", port: 7801 },
      appUrl: "https://app.test",
      repoPath: "/home/tester/work/kairoku",
      ports: "31000-31003",
    });
    const check = byName(await checks(io, { probe: () => false }), "run port range");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("31000-31003");
  });

  test("O-4: a manifest that does not parse FAILs with the path of the error", async () => {
    const io = linuxDaemon();
    io.canned["git -C /home/tester/work/kairoku show origin/main:kairoku.json"] = {
      stdout: JSON.stringify({ env: { test: { ports: [1] } } }),
    };
    const check = byName(await checks(io, freeProbe), "kairoku.json");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("env.test.ports[0] must be a string");
  });

  test("O-4: no manifest on the base branch is a WARN — today's behaviour, not a fault", async () => {
    const io = linuxDaemon();
    io.canned["git -C /home/tester/work/kairoku show origin/main:kairoku.json"] = { code: 128, stdout: "" };
    const check = byName(await checks(io, freeProbe), "kairoku.json");
    expect(check?.status).toBe("WARN");
    expect(await run([], io)).toBe(0);
  });

  test("O-4: no resolver on this machine is a WARN naming what a run would fail on", async () => {
    const io = linuxDaemon();
    io.bins.delete("op");
    const check = byName(await checks(io, freeProbe), "secret resolvers");
    expect(check?.status).toBe("WARN");
    expect(check?.detail).toContain("{ref}");
  });
});

// -------------------------------------------------------------------- §21 CI-1

describe("§21 — doctor's three new lines", () => {
  test("ast-grep: its version when present, a FAIL when the configured repo declares rules without it", async () => {
    const io = linuxDaemon();
    expect(byName(await checks(io, { probe: () => true }), "ast-grep")?.detail).toBe("ast-grep 0.45.2");

    // Absent AND the base branch declares rules: every run of this repo would
    // fail closed, so the machine is broken for it, not merely degraded.
    io.bins.delete("ast-grep");
    const broken = await checks(io, { probe: () => true });
    expect(byName(broken, "ast-grep")?.status).toBe("FAIL");
    expect(byName(broken, "ast-grep")?.detail).toContain(".kairoku/rules");
  });

  test("ast-grep absent on a repo with NO rules is a WARN, not a FAIL", async () => {
    const io = linuxDaemon();
    io.bins.delete("ast-grep");
    io.canned["git -C /home/tester/work/kairoku ls-tree -r --name-only origin/main -- .kairoku/rules"] = { stdout: "" };
    expect(byName(await checks(io, { probe: () => true }), "ast-grep")?.status).toBe("WARN");
  });

  test("the rule count for the configured repo's base branch", async () => {
    const io = linuxDaemon();
    expect(byName(await checks(io, { probe: () => true }), "rules on base branch")?.detail).toBe("2");
    io.canned["git -C /home/tester/work/kairoku ls-tree -r --name-only origin/main -- .kairoku/rules"] = { stdout: "" };
    expect(byName(await checks(io, { probe: () => true }), "rules on base branch")?.detail).toBe("0");
  });

  test("typescript-language-server is a WARN when absent, never a FAIL (§21 Q14)", async () => {
    const io = linuxDaemon();
    expect(byName(await checks(io, { probe: () => true }), "typescript-language-server")?.status).toBe("PASS");
    io.bins.delete("typescript-language-server");
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "typescript-language-server")?.status).toBe("WARN");
    expect(list.filter((c) => c.status === "FAIL")).toEqual([]);
  });

  test("§21 item 3 — codegraph absent is a WARN, never a FAIL: the probation degrades, it does not block", async () => {
    const io = linuxDaemon();
    expect(byName(await checks(io, { probe: () => true }), "codegraph")?.detail).toBe("1.0.1");
    io.bins.delete("codegraph");
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "codegraph")?.status).toBe("WARN");
    expect(byName(list, "codegraph")?.detail).toContain("intelligence");
    expect(list.filter((c) => c.status === "FAIL")).toEqual([]);
  });

  test("§21 item 5b — a global codex entry carrying the bearer env var FAILS, naming the flag", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.codex/config.toml"] =
      '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\nbearer_token_env_var = "KAIROKU_PAT"\n';
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "codex MCP is a human login")?.status).toBe("FAIL");
    expect(byName(list, "codex MCP is a human login")?.detail).toContain("bearer_token_env_var");
  });

  test("§21 item 5b — an OAuth-only entry passes", async () => {
    const io = linuxDaemon();
    io.files["/home/tester/.codex/config.toml"] = '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\n';
    expect(byName(await checks(io, { probe: () => true }), "codex MCP is a human login")?.status).toBe("PASS");
  });

  // ---------------------------------------------------------- plugin/codex-manifest
  //
  // The defect this lane exists for: a Codex install of the plugin gets its
  // `kairoku` MCP entry from the PLUGIN's own manifest, not a machine-wide
  // `[mcp_servers.kairoku]` block in config.toml — so the config.toml text
  // check above never sees it, placeholder or not. Only `codex mcp get` (the
  // resolved view) surfaces the entry at all.

  test("item 2 — a resolved URL still carrying the unresolved placeholder FAILs, naming the fix", async () => {
    const io = linuxDaemon();
    delete io.files["/home/tester/.codex/config.toml"];
    io.canned["codex mcp get kairoku --json"] = {
      stdout: JSON.stringify({ transport: { url: "${user_config.kairoku_url}/api/mcp" } }),
    };
    const check = byName(await checks(io, { probe: () => true }), "codex MCP is a human login");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("${user_config.kairoku_url}/api/mcp");
    expect(check?.detail).toContain("codex plugin update");
    expect(check?.detail).toContain("codex mcp add kairoku --url");
  });

  test("item 2 — a resolved absolute URL passes even with no config.toml entry at all", async () => {
    const io = linuxDaemon();
    delete io.files["/home/tester/.codex/config.toml"];
    io.canned["codex mcp get kairoku --json"] = {
      stdout: JSON.stringify({ transport: { url: "https://kairoku.io/api/mcp" } }),
    };
    expect(byName(await checks(io, { probe: () => true }), "codex MCP is a human login")?.status).toBe("PASS");
  });

  test("item 2 — codex not on PATH never crashes the check; it falls back to config.toml", async () => {
    const io = linuxDaemon();
    io.bins.delete("codex");
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "codex MCP is a human login")?.status).toBe("PASS");
  });
});

// -------------------------------------------------------------- W3 Q14 Slack

describe("Q14 — Slack connection doctor", () => {
  test("a connected Slack section PASSes with the team name and never echoes secrets", async () => {
    const io = linuxDaemon();
    const list = await checks(io, { probe: () => true });
    const check = byName(list, "slack connection")!;
    expect(check.status).toBe("PASS");
    expect(check.detail).toContain("Acme Workspace");
    expect(JSON.stringify(list)).not.toMatch(/xox[baprs]-/i);
  });

  test("absent slack on /status emits no row at all — the runner never reports Slack", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (!url.endsWith("/status")) return app(url, init);
      const status = await (await app(url, init)).json();
      delete status.slack;
      return Response.json(status);
    };
    expect(byName(await checks(io, { probe: () => true }), "slack connection")).toBeUndefined();
    expect(await run([], io)).toBe(0);
  });

  test("not_installed is a WARN with the install hint", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (!url.endsWith("/status")) return app(url, init);
      const status = await (await app(url, init)).json();
      status.slack = { entryId: "slack", status: "not_installed" };
      return Response.json(status);
    };
    const check = byName(await checks(io, { probe: () => true }), "slack connection");
    expect(check).toEqual({
      name: "slack connection",
      status: "WARN",
      detail: "not installed — connect Slack in desktop Connections (full install / OAuth stays there)",
    });
  });

  test("probe_failed FAILs with an actionable reconnect hint", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (!url.endsWith("/status")) return app(url, init);
      const status = await (await app(url, init)).json();
      status.slack = { status: "probe_failed", lastError: "auth.test refused" };
      return Response.json(status);
    };
    const check = byName(await checks(io, { probe: () => true }), "slack connection");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("auth.test refused");
    expect(check?.detail).toContain("desktop Connections");
    expect(await run([], io)).toBe(1);
  });

  test("auth_required FAILs naming OAuth in desktop", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (!url.endsWith("/status")) return app(url, init);
      const status = await (await app(url, init)).json();
      status.slack = { status: "auth_required" };
      return Response.json(status);
    };
    const check = byName(await checks(io, { probe: () => true }), "slack connection");
    expect(check?.status).toBe("FAIL");
    expect(check?.detail).toContain("OAuth");
    expect(check?.detail).toContain("desktop Connections");
  });

  test("a token-shaped lastError is redacted and never printed", async () => {
    const io = linuxDaemon();
    const leak = "xoxb-1234567890-abcdefghijklmnop";
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (!url.endsWith("/status")) return app(url, init);
      const status = await (await app(url, init)).json();
      status.slack = { status: "error", lastError: `refresh failed with ${leak}` };
      return Response.json(status);
    };
    const list = await checks(io, { probe: () => true });
    const check = byName(list, "slack connection")!;
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("[redacted]");
    expect(check.detail).not.toContain(leak);
    expect(JSON.stringify(list)).not.toContain(leak);
    expect(await run([], io)).toBe(1);
    expect(io.lines.join("\n")).not.toContain(leak);
  });

  test("a runner that is not listening emits no Slack row — kairokud owns that answer", async () => {
    const io = linuxDaemon();
    const app = io.fetch;
    io.fetch = async (url, init) => {
      if (url.startsWith("http://10.0.0.5")) throw new Error("refused");
      return app(url, init);
    };
    const list = await checks(io, { probe: () => true });
    expect(byName(list, "slack connection")).toBeUndefined();
    expect(byName(list, "daemon reachable")?.status).toBe("FAIL");
  });

  test("a laptop without a daemon skips the Slack line entirely", async () => {
    const list = await checks(laptop());
    expect(byName(list, "slack connection")).toBeUndefined();
  });
});
// ------------------------------------------ the desktop daemon (kairokud) group

/**
 * A fake kairokud local listener: newline-delimited JSON-RPC 2.0 over a Unix
 * socket, the framing `crates/kairoku-transport/src/listener.rs` serves and
 * `crates/kairokud/src/client.rs` writes. `answers` is keyed by method.
 */
function fakeKairokud(socketPath: string, answers: Record<string, unknown>) {
  return Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line) as { id: number; method: string };
          const answer = answers[req.method];
          const body =
            answer === undefined
              ? { error: { code: -32601, message: `method not found: ${req.method}` } }
              : { result: answer };
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body })}\n`);
        }
      },
    },
  });
}

describe("desktop daemon (kairokud)", () => {
  const dirs: string[] = [];
  const servers: ReturnType<typeof fakeKairokud>[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.stop(true);
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** A laptop whose kairokud is serving `answers` on a real socket. */
  function withDaemon(answers: Record<string, unknown>): FakeIo {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-kairokud-"));
    dirs.push(dir);
    const socketPath = join(dir, "kairokud.sock");
    servers.push(fakeKairokud(socketPath, answers));
    const io = laptop();
    io.env.KAIROKUD_SOCKET = socketPath;
    // The fake Io's `exists` is its in-memory file map; the socket is real.
    io.files[socketPath] = "";
    return io;
  }

  const SYSTEM_STATUS = { running: true, version: "0.9.3", uptimeSeconds: 3_725, protocolVersion: 3 };
  const slackStatus = (over: Record<string, unknown>) => ({
    kind: "slackStatus",
    entryId: "slack",
    installed: false,
    hasToken: false,
    credentialId: null,
    status: "notInstalled",
    teamId: null,
    teamName: null,
    flow: null,
    ...over,
  });

  test("no socket is a WARN naming the default path, and the group stops there", async () => {
    const io = laptop();
    const list = await checks(io);
    expect(byName(list, "desktop daemon (kairokud)")).toEqual({
      name: "desktop daemon (kairokud)",
      status: "WARN",
      detail: "desktop daemon not running — no socket at /home/tester/.kairoku/daemon/kairokud.sock",
    });
    expect(byName(list, "desktop daemon slack")).toBeUndefined();
  });

  test("KAIROKUD_DATA_DIR moves the socket, KAIROKUD_SOCKET overrides it outright", async () => {
    const io = laptop();
    io.env.KAIROKUD_DATA_DIR = "/srv/kairokud";
    expect(byName(await checks(io), "desktop daemon (kairokud)")?.detail).toContain("/srv/kairokud/kairokud.sock");
    io.env.KAIROKUD_SOCKET = "/run/kd.sock";
    expect(byName(await checks(io), "desktop daemon (kairokud)")?.detail).toContain("/run/kd.sock");
  });

  test("a healthy daemon PASSes with its version and uptime", async () => {
    const io = withDaemon({ "system.status": SYSTEM_STATUS, "integration.slack.status": slackStatus({}) });
    const check = byName(await checks(io), "desktop daemon (kairokud)")!;
    expect(check.status).toBe("PASS");
    expect(check.detail).toContain("0.9.3");
    expect(check.detail).toContain("up 1h 2m");
  });

  test("connected Slack PASSes with the workspace name and never the credential id", async () => {
    const io = withDaemon({
      "system.status": SYSTEM_STATUS,
      "integration.slack.status": slackStatus({
        installed: true,
        hasToken: true,
        credentialId: "3f1c9e2a-1f45-4a51-9f2e-9a2f0c1d3b44",
        status: "connected",
        teamId: "T0123456789",
        teamName: "Acme",
      }),
    });
    const list = await checks(io);
    expect(byName(list, "desktop daemon slack")).toEqual({
      name: "desktop daemon slack",
      status: "PASS",
      detail: "connected — Acme",
    });
    expect(JSON.stringify(list)).not.toContain("3f1c9e2a");
    expect(JSON.stringify(list)).not.toContain("T0123456789");
    expect(await run([], io)).toBe(0);
  });

  test("installed without a token is a WARN, not a PASS", async () => {
    const io = withDaemon({
      "system.status": SYSTEM_STATUS,
      "integration.slack.status": slackStatus({ installed: true, status: "installed" }),
    });
    expect(byName(await checks(io), "desktop daemon slack")).toEqual({
      name: "desktop daemon slack",
      status: "WARN",
      detail: "installed, no token — reconnect Slack in desktop Connections",
    });
  });

  test("notInstalled is a WARN with the connect hint", async () => {
    const io = withDaemon({ "system.status": SYSTEM_STATUS, "integration.slack.status": slackStatus({}) });
    expect(byName(await checks(io), "desktop daemon slack")).toEqual({
      name: "desktop daemon slack",
      status: "WARN",
      detail: "not installed — connect Slack in desktop Connections",
    });
  });

  test("a daemon too old to know the method WARNs instead of failing the machine", async () => {
    const io = withDaemon({ "system.status": SYSTEM_STATUS });
    const list = await checks(io);
    expect(byName(list, "desktop daemon (kairokud)")?.status).toBe("PASS");
    const slack = byName(list, "desktop daemon slack")!;
    expect(slack.status).toBe("WARN");
    expect(slack.detail).toContain("integration.slack.status");
    // Never a FAIL: the desktop daemon is optional, so it cannot fail a runner.
    expect(await run([], io)).toBe(0);
  });

  test("a stale socket file nobody is serving is the same WARN as no socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-kairokud-"));
    dirs.push(dir);
    const socketPath = join(dir, "kairokud.sock");
    // A real leftover file on disk, so `Bun.connect` refuses it the way it does
    // after a crash — not an in-memory fake the production `Io` cannot produce.
    writeFileSync(socketPath, "");
    const io = laptop();
    io.env.KAIROKUD_SOCKET = socketPath;
    io.files[socketPath] = "";
    const check = byName(await checks(io), "desktop daemon (kairokud)")!;
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("did not answer");
  });

  test("a daemon that answers one method and hangs up reports that, never a version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-kairokud-"));
    dirs.push(dir);
    const socketPath = join(dir, "kairokud.sock");
    servers.push(
      Bun.listen({
        unix: socketPath,
        socket: {
          data(socket, chunk) {
            for (const line of chunk.toString().split("\n")) {
              if (!line.trim()) continue;
              const req = JSON.parse(line) as { id: number; method: string };
              if (req.method !== "integration.slack.status") continue; // system.status never answered
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: slackStatus({}) })}\n`);
              socket.end();
            }
          },
        },
      }),
    );
    const io = laptop();
    io.env.KAIROKUD_SOCKET = socketPath;
    io.files[socketPath] = "";
    const list = await checks(io);
    expect(byName(list, "desktop daemon (kairokud)")).toEqual({
      name: "desktop daemon (kairokud)",
      status: "WARN",
      detail: `${socketPath} did not answer system.status`,
    });
    // The one answer that did arrive is still reported, and neither row FAILs.
    expect(byName(list, "desktop daemon slack")?.status).toBe("WARN");
    expect(await run([], io)).toBe(0);
  });

  test("replies are matched by id, out of order and across a split frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-kairokud-"));
    dirs.push(dir);
    const socketPath = join(dir, "kairokud.sock");
    servers.push(
      Bun.listen({
        unix: socketPath,
        socket: {
          data(socket, chunk) {
            const ids = chunk
              .toString()
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => (JSON.parse(line) as { id: number }).id);
            if (ids.length < 2) return;
            // Second method first, both frames in one write, cut mid-frame.
            const frames =
              `${JSON.stringify({ jsonrpc: "2.0", id: ids[1], result: { n: 2 } })}\n` +
              `${JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: { n: 1 } })}\n`;
            socket.write(frames.slice(0, 9));
            socket.write(frames.slice(9));
          },
        },
      }),
    );
    const [first, second] = await kairokudRpc(socketPath, ["system.status", "integration.slack.status"], 2_000);
    expect(first?.result).toEqual({ n: 1 });
    expect(second?.result).toEqual({ n: 2 });
  });
});
