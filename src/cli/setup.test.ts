import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as realIo } from "./io";
import { run } from "./setup";
import { DEFAULT_APP_REPO, DEFAULT_APP_URL } from "./provision";
import { fakeIo, type FakeIo } from "./testkit";

const calls = (io: FakeIo) => io.calls.map((c) => c.join(" "));
const home = "/home/neil";
const pluginInstallCalls = [
  "claude plugin marketplace list --json",
  "claude plugin marketplace add owds-inc/kairoku",
  "claude plugin list --json",
  "claude plugin install kairoku@kairoku-marketplace --scope user",
];

function withClaude(io = fakeIo()): FakeIo {
  io.bins.add("claude");
  io.canned["claude plugin marketplace list --json"] = { stdout: "[]" };
  io.canned["claude plugin list --json"] = { stdout: "[]" };
  return io;
}

/** A linux VM with everything already in place: every provisioning step is a skip. */
function provisionedVm(): FakeIo {
  const io = withClaude(fakeIo({ platform: "linux", home, env: { USER: "neil", PATH: "/usr/bin:/bin" } }));
  for (const b of ["node", "bun", "codex", "paseo", "git", "docker"]) io.bins.add(b);
  Object.assign(io.canned, {
    "node --version": { stdout: "v24.1.0\n" },
    "bun --version": { stdout: "1.3.14\n" },
    "sudo -n true": { code: 0 },
    "docker compose version": { stdout: "Docker Compose version v5.4.0\n" },
  });
  Object.assign(io.files, {
    [`${home}/.bashrc`]: `export PATH="${home}/.bun/bin:$PATH"\n`,
    [`${home}/work/kairoku/.git`]: "",
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
    "/etc/sysctl.d/99-codex-userns.conf": "kernel.apparmor_restrict_unprivileged_userns=0\n",
    [`${home}/.codex/config.toml`]: 'bearer_token_env_var = "KAIROKU_PAT"\ndefault_tools_approval_mode = "approve"\n',
    [`${home}/.codex/auth.json`]: "{}",
    [`${home}/.claude`]: "",
    [`${home}/.kairoku/token.env`]: "KAIROKU_DAEMON_TOKEN=kai_secret_token\n",
    [`${home}/.kairoku/config.json`]: JSON.stringify({
      listen: { host: "127.0.0.1", port: 7801 },
      appUrl: "https://app.test",
      maxConcurrent: 2,
      repoPath: `${home}/work/kairoku`,
      repoUrl: "https://example.com/app.git",
      ports: "20000-29999",
    }),
  });
  io.modes[`${home}/.kairoku/token.env`] = 0o600;
  io.fetch = appAndDaemon(io);
  return io;
}

/** The tokens this fake app has actually minted. Anything else is a 401. */
const APP_TOKENS = ["kai_secret_token", "kai_fresh_token", "kai_pasted_token"];

/** The app answering a heartbeat, and the local listener answering `/status`. */
function appAndDaemon(_io: FakeIo): FakeIo["fetch"] {
  return async (url, init) => {
    if (url === "http://127.0.0.1:7801/status") {
      return Response.json({ version: "0.1.0", capacity: { running: 0, max: 2 }, link: { linked: true }, runs: [] });
    }
    if (url.endsWith("/api/daemon/heartbeat")) {
      const offered = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (!APP_TOKENS.includes(offered)) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ daemon: { id: "d", name: "vm" }, liveness: "online", heartbeatIntervalMs: 30_000, protocol: "1", runs: [] });
    }
    return new Response("", { status: 404 });
  };
}

describe("kairoku setup — plugin", () => {
  test("--plugin --yes installs the plugin without a prompt", async () => {
    const io = withClaude();
    expect(await run(["--plugin", "--yes"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(calls(io)).toEqual(pluginInstallCalls);
  });

  test("a selecting flag alone never prompts either", async () => {
    const io = withClaude();
    expect(await run(["--plugin"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(calls(io)).toEqual(pluginInstallCalls);
  });

  test("the wizard asks two questions; defaults are plugin yes, daemon no", async () => {
    const io = withClaude();
    io.answers = ["", ""];
    expect(await run([], io)).toBe(0);
    expect(io.questions).toHaveLength(2);
    expect(io.questions[0]).toMatch(/plugin.*\[Y\/n\]/i);
    expect(io.questions[1]).toMatch(/daemon.*\[y\/N\]/i);
    expect(calls(io)).toEqual(pluginInstallCalls);
    expect(io.lines.join("\n")).not.toContain("== daemon");
  });

  test("a failing plugin step stops the run with its exit code", async () => {
    const io = fakeIo(); // no claude on PATH
    expect(await run(["--all", "--yes"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("npm install -g @anthropic-ai/claude-code");
    expect(io.lines.join("\n")).not.toContain("== daemon");
  });

  test("declining both is a no-op", async () => {
    const io = withClaude();
    io.answers = ["n", "n"];
    expect(await run([], io)).toBe(0);
    expect(calls(io)).toEqual([]);
    expect(io.lines.join("\n")).toContain("nothing selected");
  });

  test("an unknown flag prints usage and exits 2; --help exits 0", async () => {
    const io = withClaude();
    expect(await run(["--frob"], io)).toBe(2);
    expect(io.errors.join("\n")).toContain("kairoku setup [--plugin] [--daemon] [--all] [--yes]");
    const help = withClaude();
    expect(await run(["--help"], help)).toBe(0);
    expect(help.lines.join("\n")).toContain("--repo");
  });
});

describe("kairoku setup — daemon", () => {
  test("--daemon --yes on a provisioned VM skips every step, installs the service, round-trips, exits 0", async () => {
    const io = provisionedVm();
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    const out = io.lines.join("\n");
    for (const skipped of ["not upgrading", "already above the interactive guard", `already at ${home}/work/kairoku`, "already 0 and persisted", "already set", "v5.4.0 already installed"]) {
      expect(out).toContain(skipped);
    }
    expect(out).toContain("unit written to /etc/systemd/system/kairoku-daemon.service");
    expect(calls(io)).toContain("sudo systemctl enable --now kairoku-daemon");
    expect(out).toMatch(/PASS\s+daemon reachable/);
    expect(out).toContain("app link proved");
    expect(out).toContain("Nothing human-only is outstanding");
    expect(out).not.toContain("kai_secret_token");
    expect(calls(io).some((c) => c.startsWith("git clone"))).toBe(false);
  });

  test("the app repo: config.json's repoUrl wins, --repo overrides and is recorded, else the wizard asks with the default", async () => {
    const io = provisionedVm();
    delete io.files[`${home}/work/kairoku/.git`];
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(calls(io)).toContain(`git clone https://example.com/app.git ${home}/work/kairoku`);

    const flagged = provisionedVm();
    delete flagged.files[`${home}/work/kairoku/.git`];
    expect(await run(["--daemon", "--repo", "https://other.example/app.git"], flagged)).toBe(0);
    expect(flagged.questions).toEqual([]);
    expect(calls(flagged)).toContain(`git clone https://other.example/app.git ${home}/work/kairoku`);
    expect(JSON.parse(flagged.files[`${home}/.kairoku/config.json`]!).repoUrl).toBe("https://other.example/app.git");

    const asked = provisionedVm();
    delete asked.files[`${home}/work/kairoku/.git`];
    const { repoUrl: _drop, ...rest } = JSON.parse(asked.files[`${home}/.kairoku/config.json`]!);
    asked.files[`${home}/.kairoku/config.json`] = JSON.stringify(rest);
    asked.answers = [""];
    expect(await run(["--daemon"], asked)).toBe(0);
    expect(asked.questions[0]).toContain(DEFAULT_APP_REPO);
    expect(calls(asked)).toContain(`git clone ${DEFAULT_APP_REPO} ${home}/work/kairoku`);
    expect(JSON.parse(asked.files[`${home}/.kairoku/config.json`]!).repoUrl).toBe(DEFAULT_APP_REPO);
    expect(JSON.parse(asked.files[`${home}/.kairoku/config.json`]!).listen).toEqual({ host: "127.0.0.1", port: 7801 });
  });

  test("a failing service install stops with its code; an unreachable daemon exits 1", async () => {
    const io = provisionedVm();
    io.canned["sudo systemctl enable --now kairoku-daemon"] = { code: 1 };
    expect(await run(["--daemon", "--yes"], io)).toBe(1);
    expect(io.lines.join("\n")).not.toContain("daemon reachable");

    const deaf = provisionedVm();
    const inner = deaf.fetch;
    deaf.fetch = async (url, init) => (url.startsWith("http://127.0.0.1") ? Promise.reject(new Error("refused")) : inner(url, init));
    expect(await run(["--daemon", "--yes"], deaf)).toBe(1);
    expect(deaf.lines.join("\n")).toMatch(/FAIL\s+daemon reachable/);
  });

  test("the app link is proved with one heartbeat BEFORE the service is installed", async () => {
    const io = provisionedVm();
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    const order = io.lines.join("\n");
    expect(order.indexOf("app link proved")).toBeLessThan(order.indexOf("== daemon service"));
  });

  test("a 401 stops setup with the exact message, and no service is installed", async () => {
    const io = provisionedVm();
    io.files[`${home}/.kairoku/token.env`] = "KAIROKU_DAEMON_TOKEN=kai_a_stale_token\n";
    expect(await run(["--daemon", "--yes"], io)).toBe(1);
    expect(io.lines.join("\n")).toContain("token not accepted by https://app.test");
    expect(io.lines.join("\n")).not.toContain("kai_a_stale_token");
    expect(calls(io).some((c) => c.includes("systemctl enable"))).toBe(false);
  });

  test("--daemon records where the plugin actually is, so a released daemon never resolves it cold", async () => {
    // The daemon is a compiled binary: it has no checkout beside it, and the
    // path `claude plugin install` used is the one thing on this machine that
    // knows where the plugin went. Recording it here is what makes a cold start
    // on a fresh box hand the SDK a real plugin instead of refusing the run.
    const io = provisionedVm();
    const installPath = `${home}/.claude/plugins/cache/kairoku-marketplace/kairoku/2.3.0`;
    io.canned["claude plugin list --json"] = {
      stdout: JSON.stringify([
        { id: "kairoku@kairoku-marketplace", version: "2.3.0", enabled: true, scope: "user", installPath },
      ]),
    };
    io.files[`${installPath}/.claude-plugin/plugin.json`] = '{"name":"kairoku"}';

    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).pluginPath).toBe(installPath);
  });

  test("no plugin on the machine records no pluginPath — a guess would be worse than the fail-closed message", async () => {
    const io = provisionedVm();
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).pluginPath).toBeUndefined();
  });

  test("--app-url and --app-token set the link without a prompt; the token lands 0600, never printed", async () => {
    const io = provisionedVm();
    delete io.files[`${home}/.kairoku/token.env`];
    delete io.modes[`${home}/.kairoku/token.env`];
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({ listen: { host: "127.0.0.1", port: 7801 }, maxConcurrent: 2, repoUrl: "https://example.com/app.git" });

    expect(await run(["--daemon", "--yes", "--app-url", "https://app.test/", "--app-token", "kai_fresh_token"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(io.files[`${home}/.kairoku/token.env`]).toBe("KAIROKU_DAEMON_TOKEN=kai_fresh_token\n");
    expect(io.modes[`${home}/.kairoku/token.env`]).toBe(0o600);
    // The trailing slash is normalised once, in config.
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).appUrl).toBe("https://app.test");
    expect(io.lines.join("\n") + io.errors.join("\n")).not.toContain("kai_fresh_token");
  });

  test("the wizard asks for the app URL and the token, offering the default origin", async () => {
    const io = provisionedVm();
    delete io.files[`${home}/.kairoku/token.env`];
    // `ports` is already recorded, so the only questions here are the link's.
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({
      listen: { host: "127.0.0.1", port: 7801 },
      repoUrl: "https://example.com/app.git",
      ports: "20000-29999",
    });
    io.answers = ["https://app.test", "kai_pasted_token"];

    expect(await run(["--daemon"], io)).toBe(0);
    expect(io.questions[0]).toContain(DEFAULT_APP_URL);
    expect(io.questions[1]).toMatch(/token/i);
    expect(io.files[`${home}/.kairoku/token.env`]).toBe("KAIROKU_DAEMON_TOKEN=kai_pasted_token\n");
  });

  test("no link and no way to ask for one is a human-only step, not a failure", async () => {
    const io = provisionedVm();
    delete io.files[`${home}/.kairoku/token.env`];
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({ listen: { host: "127.0.0.1", port: 7801 }, repoUrl: "https://example.com/app.git" });
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("Settings → Daemons");
    expect(out).toContain("--app-token");
  });

  test("the wizard's daemon answer and --all / --yes alone reach the daemon flow after the plugin", async () => {
    const wizard = provisionedVm();
    wizard.answers = ["n", "y"];
    expect(await run([], wizard)).toBe(0);
    expect(wizard.lines.join("\n")).toContain("== daemon");
    expect(calls(wizard).some((c) => c.startsWith("claude plugin install"))).toBe(false);

    for (const args of [["--all", "--yes"], ["--yes"]]) {
      const io = provisionedVm();
      expect(await run(args, io)).toBe(0);
      expect(calls(io).slice(0, 4)).toEqual(pluginInstallCalls);
      expect(io.lines.join("\n")).toContain("== daemon");
    }
  });
});

describe("kairoku setup — daemon migrates a pre-rename home first", () => {
  test("~/.hikyaku is copied before anything is generated: legacy token and config survive, no new token", async () => {
    const home = mkdtempSync(join(tmpdir(), "kairoku-setup-home-"));
    try {
      const old = join(home, ".hikyaku");
      mkdirSync(join(old, "runs", "oldrun"), { recursive: true });
      writeFileSync(join(old, "config.json"), JSON.stringify({ listen: { host: "10.0.0.5", port: 7999 }, appUrl: "https://app.test", maxConcurrent: 3, repoPath: join(home, "work", "kairoku") }));
      writeFileSync(join(old, "token.env"), "HIKYAKU_TOKEN=legacy-token\n", { mode: 0o600 });
      writeFileSync(join(old, "runs", "oldrun", "events.jsonl"), "{}\n");
      mkdirSync(join(home, "work", "kairoku", ".git"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), 'bearer_token_env_var = "KAIROKU_PAT"\ndefault_tools_approval_mode = "approve"\n');
      writeFileSync(join(home, ".codex", "auth.json"), "{}");
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".bashrc"), `export PATH="${home}/.bun/bin:$PATH"\n`);
      // The filesystem is real (the migration copies real files); shell, prompts and fetch stay fake.
      const io = withClaude(fakeIo({
        platform: "linux",
        home,
        env: { USER: "neil", PATH: "/usr/bin:/bin" },
        exists: realIo.exists,
        readFile: realIo.readFile,
        mode: realIo.mode,
        writeFile: realIo.writeFile,
      }));
      for (const b of ["node", "bun", "codex", "paseo", "git", "docker"]) io.bins.add(b);
      Object.assign(io.canned, { "node --version": { stdout: "v24.1.0\n" }, "bun --version": { stdout: "1.3.14\n" }, "sudo -n true": { code: 0 } });
      const seen: string[] = [];
      io.fetch = async (url, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        seen.push(auth);
        if (url === "http://127.0.0.1:7999/status") {
          return Response.json({ version: "0.1.0", capacity: { running: 0, max: 3 }, link: { linked: true }, runs: [] });
        }
        if (url !== "https://app.test/api/daemon/heartbeat") return new Response("", { status: 404 });
        return auth === "Bearer legacy-token"
          ? Response.json({ daemon: { id: "d", name: "vm" }, liveness: "online", heartbeatIntervalMs: 30_000, runs: [] })
          : Response.json({ error: "unauthorized" }, { status: 401 });
      };

      expect(await run(["--daemon", "--yes"], io)).toBe(0);

      const fresh = join(home, ".kairoku");
      expect(readFileSync(join(fresh, "token.env"), "utf8")).toBe("KAIROKU_DAEMON_TOKEN=legacy-token\n");
      expect(statSync(join(fresh, "token.env")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(fresh, "config.json"), "utf8"))).toMatchObject({
        // The LAN bind from the push-API days is pulled back to loopback.
        listen: { host: "127.0.0.1", port: 7999 },
        maxConcurrent: 3,
        repoUrl: DEFAULT_APP_REPO,
      });
      expect(existsSync(join(fresh, "runs", "oldrun", "events.jsonl"))).toBe(true);
      expect(existsSync(join(old, "token.env"))).toBe(true);
      const out = io.lines.join("\n");
      expect(out).toContain("migrated");
      // The pre-rename token is carried over and reused as the app credential.
      expect(out).toContain("app link proved");
      expect(seen).toContain("Bearer legacy-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

});

describe("kairoku setup — daemon: environments (O-4)", () => {
  test("O-4: --yes records the default port range and asks nothing", async () => {
    const io = provisionedVm();
    const { ports: _drop, ...rest } = JSON.parse(io.files[`${home}/.kairoku/config.json`]!);
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify(rest);

    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).ports).toBe("20000-29999");
  });

  test("O-4: the wizard asks for the range, offering the default, and records the answer", async () => {
    const io = provisionedVm();
    const { ports: _drop, ...rest } = JSON.parse(io.files[`${home}/.kairoku/config.json`]!);
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify(rest);
    io.answers = ["31000-31999"];

    expect(await run(["--daemon"], io)).toBe(0);
    expect(io.questions.join("\n")).toContain("20000-29999");
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).ports).toBe("31000-31999");
  });

  test("O-4: a range the operator typed wrong is refused rather than written", async () => {
    // Written, it would sit in config.json doing nothing visible until the
    // first run with a compose profile failed to get a port.
    const io = provisionedVm();
    const { ports: _drop, ...rest } = JSON.parse(io.files[`${home}/.kairoku/config.json`]!);
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify(rest);
    io.answers = ["twenty thousand", "31000-31999"];

    expect(await run(["--daemon"], io)).toBe(0);
    expect(io.questions).toHaveLength(2);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).ports).toBe("31000-31999");
  });

  test("O-4: a VM with no docker gets it installed as part of --daemon", async () => {
    const io = provisionedVm();
    io.bins.delete("docker");
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(calls(io).some((c) => c.includes("docker.io docker-compose-plugin"))).toBe(true);
    expect(io.lines.join("\n")).toContain("log out and back in");
  });
});
