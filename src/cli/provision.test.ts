import { describe, expect, test } from "bun:test";
import { checkout, codexConfig, daemonConfig, DEFAULT_APP_REPO, remainder, runtimes, shellPath, userns, type Step } from "./provision";
import { fakeIo, type FakeIo } from "./testkit";

const calls = (io: FakeIo) => io.calls.map((c) => c.join(" "));
const home = "/home/neil";

function vm(): FakeIo {
  const io = fakeIo({ platform: "linux", home, env: { USER: "neil", PATH: "/usr/bin:/bin" } });
  for (const b of ["node", "bun", "claude", "codex", "paseo", "git"]) io.bins.add(b);
  io.canned["node --version"] = { stdout: "v24.1.0\n" };
  io.canned["bun --version"] = { stdout: "1.3.14\n" };
  io.canned["sudo -n true"] = { code: 0 };
  return io;
}

describe("runtimes", () => {
  test("everything present is skipped, nothing installed", async () => {
    const io = vm();
    const steps = await runtimes(io);
    expect(steps.map((s) => s.outcome)).toEqual(["skipped", "skipped", "skipped"]);
    expect(calls(io).filter((c) => /curl|npm/.test(c))).toEqual([]);
  });

  test("old node is installed through nvm, absent bun through bun.sh, only the missing CLIs through npm", async () => {
    const io = vm();
    io.canned["node --version"] = { stdout: "v18.0.0\n" };
    io.bins.delete("bun");
    io.bins.delete("codex");
    io.bins.delete("paseo");
    const steps = await runtimes(io);
    expect(steps.map((s) => s.outcome)).toEqual(["done", "done", "done"]);
    const c = calls(io);
    expect(c.find((l) => l.includes("nvm-sh/nvm") && l.includes("nvm install 24"))).toBeDefined();
    expect(c.find((l) => l.includes("https://bun.sh/install"))).toBeDefined();
    expect(c).toContain("npm install -g @openai/codex @getpaseo/cli");
    expect(c.find((l) => l.includes("@anthropic-ai/claude-code"))).toBeUndefined();
  });

  test("a rerun never upgrades a runtime out from under a running agent", async () => {
    const io = vm();
    io.canned["node --version"] = { stdout: "v25.2.0\n" };
    const steps = await runtimes(io);
    expect(steps[0]).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("not upgrading") });
  });
});

describe("non-interactive PATH", () => {
  test("prepends the export as line 1 of ~/.bashrc once", async () => {
    const io = vm();
    io.files[`${home}/.bashrc`] = "# ~/.bashrc\ncase $- in *i*) ;; *) return;; esac\n";
    expect((await shellPath(io)).outcome).toBe("done");
    const lines = io.files[`${home}/.bashrc`]!.split("\n");
    expect(lines[0]).toBe(`export PATH="${home}/.bun/bin:/usr/bin:$PATH"`);
    expect(lines[1]).toBe("# ~/.bashrc");
    expect((await shellPath(io)).outcome).toBe("skipped");
  });

  test("is not needed on mac", async () => {
    const io = fakeIo({ platform: "darwin" });
    expect((await shellPath(io)).outcome).toBe("skipped");
  });
});

describe("the app checkout", () => {
  test("clones with plain git into ~/work/kairoku and installs, then is skipped", async () => {
    const io = vm();
    const step = await checkout(io, "https://example.com/app.git");
    expect(step.outcome).toBe("done");
    expect(calls(io)).toContain(`git clone https://example.com/app.git ${home}/work/kairoku`);
    expect(calls(io)).toContain(`bun install --cwd ${home}/work/kairoku`);
    io.files[`${home}/work/kairoku/.git`] = "";
    io.calls = [];
    expect((await checkout(io, "https://example.com/app.git")).outcome).toBe("skipped");
    expect(calls(io).some((c) => c.startsWith("git clone"))).toBe(false);
  });

  test("a failing clone is reported, never retried silently", async () => {
    const io = vm();
    io.canned["git clone"] = { code: 128, stderr: "fatal: repository not found\n" };
    const step = await checkout(io, DEFAULT_APP_REPO);
    expect(step).toMatchObject({ outcome: "manual", detail: expect.stringContaining("repository not found") });
  });
});

describe("user namespaces (codex sandbox)", () => {
  const knob = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  test("without sudo the two commands are handed back", async () => {
    const io = vm();
    io.canned["sudo -n true"] = { code: 1 };
    const step = await userns(io);
    expect(step.outcome).toBe("manual");
    expect(step.detail).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(step.detail).toContain("/etc/sysctl.d/99-codex-userns.conf");
  });

  test("already 0 and persisted is skipped; otherwise set and persisted", async () => {
    const io = vm();
    io.files[knob] = "0\n";
    io.files["/etc/sysctl.d/99-codex-userns.conf"] = "kernel.apparmor_restrict_unprivileged_userns=0\n";
    expect((await userns(io)).outcome).toBe("skipped");
    io.files[knob] = "1\n";
    expect((await userns(io)).outcome).toBe("done");
    expect(calls(io)).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(calls(io).some((c) => c.startsWith("sudo sh -c") && c.includes("/etc/sysctl.d/99-codex-userns.conf"))).toBe(true);
  });

  test("a kernel without the knob is skipped, and mac has none", async () => {
    const io = vm();
    expect((await userns(io))).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("absent") });
    expect((await userns(fakeIo({ platform: "darwin" }))).outcome).toBe("skipped");
  });
});

describe("codex MCP approval mode", () => {
  const cfg = `${home}/.codex/config.toml`;
  test("no config yet is a manual step naming codex login", async () => {
    const io = vm();
    expect(await codexConfig(io)).toMatchObject({ outcome: "manual", detail: expect.stringContaining("codex login") });
  });
  test("inserts the approve line after the kairoku MCP entry, once", async () => {
    const io = vm();
    io.files[cfg] = '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\nbearer_token_env_var = "KAIROKU_PAT"\n';
    expect((await codexConfig(io)).outcome).toBe("done");
    expect(io.files[cfg]).toBe('[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\nbearer_token_env_var = "KAIROKU_PAT"\ndefault_tools_approval_mode = "approve"\n');
    expect((await codexConfig(io)).outcome).toBe("skipped");
  });
  test("without the kairoku MCP entry the add command is handed back", async () => {
    const io = vm();
    io.files[cfg] = "model = \"o3\"\n";
    expect(await codexConfig(io)).toMatchObject({ outcome: "manual", detail: expect.stringContaining("codex mcp add kairoku") });
  });
});

describe("daemon config", () => {
  test("config.json binds loopback and no inbound bearer is minted (SPEC v1)", async () => {
    // The listener used to be a LAN-bound push API behind a bearer. With the
    // push API retired it answers `doctor` and nothing else, unauthenticated —
    // so it belongs on 127.0.0.1 and there is no secret left to generate here.
    const io = vm();
    const steps = await daemonConfig(io, `${home}/work/kairoku`);
    expect(steps.map((s) => s.outcome)).toEqual(["done"]);
    expect(io.files[`${home}/.kairoku/token.env`]).toBeUndefined();
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!)).toEqual({
      listen: { host: "127.0.0.1", port: 7801 },
      maxConcurrent: 2,
      repoPath: `${home}/work/kairoku`,
    });
    expect(calls(io).some((c) => c.startsWith("hostname") || c.startsWith("ipconfig"))).toBe(false);

    const again = await daemonConfig(io, `${home}/work/kairoku`);
    expect(again.map((s) => s.outcome)).toEqual(["skipped"]);
  });

  test("a config left bound to a LAN address from the push-API days is pulled back to loopback", async () => {
    const io = vm();
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({
      listen: { host: "192.168.23.167", port: 7801 },
      maxConcurrent: 2,
    });
    const steps = await daemonConfig(io, `${home}/work/kairoku`);
    expect(steps.some((s) => s.detail.includes("127.0.0.1"))).toBe(true);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).listen).toEqual({ host: "127.0.0.1", port: 7801 });
  });

  test("repoUrl is recorded when it changes, and the rest of the file is left alone", async () => {
    const io = vm();
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({
      listen: { host: "127.0.0.1", port: 7801 },
      maxConcurrent: 4,
    });
    await daemonConfig(io, `${home}/work/kairoku`, "https://example.com/app.git");
    const config = JSON.parse(io.files[`${home}/.kairoku/config.json`]!);
    expect(config.repoUrl).toBe("https://example.com/app.git");
    expect(config.maxConcurrent).toBe(4);
  });
});

describe("what is left is human-only", () => {
  test("lists only what is still owed", () => {
    const io = vm();
    io.files[`${home}/.claude`] = "";
    io.files[`${home}/.codex/auth.json`] = "";
    io.files[`${home}/.codex/config.toml`] = 'default_tools_approval_mode = "approve"\n';
    const steps: Step[] = [{ name: "userns", outcome: "manual", detail: "sudo …" }];
    const owed = remainder(io, steps);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toContain("userns");
    delete io.files[`${home}/.codex/auth.json`];
    expect(remainder(io, []).some((l) => l.includes("codex login"))).toBe(true);
    delete io.files[`${home}/.claude`];
    expect(remainder(io, []).some((l) => l.includes("claude"))).toBe(true);
  });
});
