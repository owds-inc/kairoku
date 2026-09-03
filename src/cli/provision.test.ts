import { describe, expect, test } from "bun:test";
import { checkout, codexConfig, CODEX_MCP_ADD, CODEX_MCP_LOGIN, daemonConfig, DEFAULT_APP_REPO, docker, languageServer, remainder, runtimes, shellPath, userns, type Step } from "./provision";
import { fakeIo, type FakeIo } from "./testkit";

const calls = (io: FakeIo) => io.calls.map((c) => c.join(" "));
const home = "/home/neil";

function vm(): FakeIo {
  const io = fakeIo({ platform: "linux", home, env: { USER: "neil", PATH: "/usr/bin:/bin" } });
  for (const b of ["node", "bun", "claude", "codex", "paseo", "git", "ast-grep"]) io.bins.add(b);
  io.canned["node --version"] = { stdout: "v24.1.0\n" };
  io.canned["bun --version"] = { stdout: "1.3.14\n" };
  io.canned["sudo -n true"] = { code: 0 };
  return io;
}

describe("runtimes", () => {
  test("everything present is skipped, nothing installed", async () => {
    const io = vm();
    const steps = await runtimes(io);
    expect(steps.map((s) => s.outcome)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(calls(io).filter((c) => /curl|npm/.test(c))).toEqual([]);
  });

  test("old node is installed through nvm, absent bun through bun.sh, only the missing CLIs through npm", async () => {
    const io = vm();
    io.canned["node --version"] = { stdout: "v18.0.0\n" };
    io.bins.delete("bun");
    io.bins.delete("codex");
    io.bins.delete("paseo");
    io.bins.delete("ast-grep");
    const steps = await runtimes(io);
    expect(steps.map((s) => s.outcome)).toEqual(["done", "done", "done", "done"]);
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

describe("codex MCP entry", () => {
  const cfg = `${home}/.codex/config.toml`;
  test("no config yet is a manual step naming codex login", async () => {
    const io = vm();
    expect(await codexConfig(io)).toMatchObject({ outcome: "manual", detail: expect.stringContaining("codex login") });
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

  test("the resolved pluginPath is recorded, and a moved one is corrected", async () => {
    // Written at provision time so a released daemon starting cold never has to
    // resolve the plugin at all; corrected on rerun because a plugin update
    // moves the version directory out from under the recorded path.
    const io = vm();
    await daemonConfig(io, `${home}/work/kairoku`, { pluginPath: "/plugins/kairoku/2.2.0" });
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).pluginPath).toBe("/plugins/kairoku/2.2.0");

    const again = await daemonConfig(io, `${home}/work/kairoku`, { pluginPath: "/plugins/kairoku/2.3.0" });
    expect(again.map((s) => s.outcome)).toEqual(["done"]);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).pluginPath).toBe("/plugins/kairoku/2.3.0");

    // Nothing resolved: the recorded value is left alone rather than deleted.
    await daemonConfig(io, `${home}/work/kairoku`);
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).pluginPath).toBe("/plugins/kairoku/2.3.0");
  });

  test("repoUrl is recorded when it changes, and the rest of the file is left alone", async () => {
    const io = vm();
    io.files[`${home}/.kairoku/config.json`] = JSON.stringify({
      listen: { host: "127.0.0.1", port: 7801 },
      maxConcurrent: 4,
    });
    await daemonConfig(io, `${home}/work/kairoku`, { repoUrl: "https://example.com/app.git" });
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
    io.files[`${home}/.codex/config.toml`] = '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\n';
    const steps: Step[] = [{ name: "userns", outcome: "manual", detail: "sudo …" }];
    const owed = remainder(io, steps);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toContain("userns");
    delete io.files[`${home}/.codex/auth.json`];
    expect(remainder(io, []).some((l) => l.includes("codex login"))).toBe(true);
    delete io.files[`${home}/.claude`];
    expect(remainder(io, []).some((l) => l.includes("claude"))).toBe(true);
  });

  test("O-4: the port range is recorded, and a rerun with the same one changes nothing", async () => {
    const io = vm();
    await daemonConfig(io, `${home}/work/kairoku`, { ports: "31000-31999" });
    expect(JSON.parse(io.files[`${home}/.kairoku/config.json`]!).ports).toBe("31000-31999");

    const again = await daemonConfig(io, `${home}/work/kairoku`, { ports: "31000-31999" });
    expect(again.map((s) => s.outcome)).toEqual(["skipped"]);
  });
});

describe("O-4: docker", () => {
  test("already installed is skipped — provisioning never upgrades a live machine's engine", async () => {
    const io = vm();
    io.bins.add("docker");
    io.canned["docker compose version"] = { stdout: "Docker Compose version v5.4.0\n" };
    expect(await docker(io)).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("v5.4.0") });
  });

  test("installed but not RUNNING is a manual step — apt cannot fix a stopped daemon", async () => {
    const io = vm();
    io.bins.add("docker");
    io.canned["docker compose version"] = { code: 1, stderr: "Cannot connect to the Docker daemon" };
    expect(await docker(io)).toMatchObject({ outcome: "manual", detail: expect.stringContaining("not answering") });
  });

  test("linux with passwordless sudo installs it from apt and says a re-login is needed", async () => {
    const io = vm();
    const step = await docker(io);
    expect(step.outcome).toBe("done");
    expect(calls(io).some((c) => c.includes("apt-get install -y docker.io docker-compose-plugin"))).toBe(true);
    // Group membership is what makes the socket usable, and it only takes
    // effect on a new login session — a step that did not say so would leave
    // every run failing with "permission denied on /var/run/docker.sock".
    expect(calls(io).some((c) => c.includes("usermod -aG docker"))).toBe(true);
    expect(step.detail).toContain("log out");
  });

  test("linux without passwordless sudo hands back the exact commands", async () => {
    const io = vm();
    io.canned["sudo -n true"] = { code: 1 };
    const step = await docker(io);
    expect(step.outcome).toBe("manual");
    expect(step.detail).toContain("apt-get install");
  });

  test("mac names the install rather than pretending it can do it", async () => {
    const io = fakeIo({ platform: "darwin", home });
    const step = await docker(io);
    expect(step.outcome).toBe("manual");
    expect(step.detail).toContain("OrbStack");
    expect(step.detail).toContain("Docker Desktop");
    expect(calls(io).some((c) => c.startsWith("sudo"))).toBe(false);
  });
});

// -------------------------------------------------------------------- §21 CI-1

describe("§21 — ast-grep is one binary setup installs", () => {
  test("absent, it is installed with the other CLIs in one npm call", async () => {
    const io = vm();
    io.bins.delete("ast-grep");
    const steps = await runtimes(io);
    expect(calls(io)).toContain("npm install -g @ast-grep/cli");
    expect(steps.find((s) => s.name === "ast-grep")).toBeDefined();
  });

  test("present, it is skipped — provisioning is not an update channel", async () => {
    const io = vm();
    io.bins.add("ast-grep");
    const steps = await runtimes(io);
    expect(steps.find((s) => s.name === "ast-grep")?.outcome).toBe("skipped");
    expect(calls(io).filter((c) => c.startsWith("npm install"))).toEqual([]);
  });
});

describe("§21 — the language server, for a repo that has a tsconfig", () => {
  test("a TypeScript checkout gets typescript-language-server through bun", async () => {
    const io = vm();
    io.files[`${home}/work/kairoku/tsconfig.json`] = "{}";
    const step = await languageServer(io, `${home}/work/kairoku`);
    expect(step.outcome).toBe("done");
    expect(calls(io)).toContain("bun add -g typescript-language-server typescript");
  });

  test("a checkout with no tsconfig installs nothing", async () => {
    const io = vm();
    const step = await languageServer(io, `${home}/work/kairoku`);
    expect(step.outcome).toBe("skipped");
    expect(calls(io).filter((c) => c.includes("typescript-language-server"))).toEqual([]);
  });

  test("already installed is skipped, never reinstalled", async () => {
    const io = vm();
    io.files[`${home}/work/kairoku/tsconfig.json`] = "{}";
    io.bins.add("typescript-language-server");
    expect((await languageServer(io, `${home}/work/kairoku`)).outcome).toBe("skipped");
    expect(calls(io).filter((c) => c.includes("bun add"))).toEqual([]);
  });

  test("a failed install is a MANUAL step, never a stopped setup — the LSP is a WARN", async () => {
    const io = vm();
    io.files[`${home}/work/kairoku/tsconfig.json`] = "{}";
    io.canned["bun add -g"] = { code: 1 };
    expect((await languageServer(io, `${home}/work/kairoku`)).outcome).toBe("manual");
  });
});

describe("§21 item 5b — the machine-wide codex MCP entry stops carrying a bearer", () => {
  const cfg = `${home}/.codex/config.toml`;

  test("the add command is OAuth, with no bearer flag, followed by a login", () => {
    expect(CODEX_MCP_ADD).not.toContain("bearer");
    expect(CODEX_MCP_ADD).toContain("codex mcp add kairoku --url https://kairoku.io/api/mcp");
    expect(CODEX_MCP_LOGIN).toContain("codex mcp login kairoku");
  });

  test("a global entry carrying the bearer env var is reported, and never rewritten in place", async () => {
    const io = vm();
    io.files[cfg] = '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\nbearer_token_env_var = "KAIROKU_PAT"\n';
    const step = await codexConfig(io);
    expect(step.outcome).toBe("manual");
    expect(step.detail).toContain("bearer_token_env_var");
    // The daemon does not edit a human's own codex config out from under them.
    expect(io.files[cfg]).toContain('bearer_token_env_var = "KAIROKU_PAT"');
  });

  test("an OAuth-only kairoku entry is what this step wants to see", async () => {
    const io = vm();
    io.files[cfg] = '[mcp_servers.kairoku]\nurl = "https://kairoku.io/api/mcp"\n';
    expect((await codexConfig(io)).outcome).toBe("skipped");
  });
});
