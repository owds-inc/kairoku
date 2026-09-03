import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolePrompt } from "../roles";
import type { Rules } from "../rules";
import { codexArgv, codexConfigToml, codexEvent, codexHooksJson, codexModels, codexProvider, writeCodexFiles } from "./codex";
import type { RoleRun } from "./types";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "kairoku-codex-")));

const run = (over: Partial<RoleRun> = {}): RoleRun => ({
  dispatchId: "d1",
  runId: "r1",
  role: "implementer",
  prompt: "build the thing",
  cwd: "/tmp/wt",
  env: { KAIROKU_PAT: "pat" },
  timeoutMs: 60_000,
  logPath: join(tmp(), "r1.log"),
  ...over,
});

describe("codex — the command line", () => {
  test("exec --json, approvals never, the worktree as the working root", () => {
    const argv = codexArgv(run(), {});
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(argv).toContain('approval_policy="never"');
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tmp/wt");
  });

  test("the sandbox comes from the role policy, not from the caller", () => {
    // implementer edits and runs; the other three read and run (§20.8).
    expect(codexArgv(run({ role: "implementer" }), {})[codexArgv(run(), {}).indexOf("-s") + 1]).toBe("workspace-write");
    for (const role of ["reviewer", "planner", "researcher"] as const) {
      const argv = codexArgv(run({ role }), {});
      expect(argv[argv.indexOf("-s") + 1]).toBe("read-only");
    }
  });

  test("a model is passed only when the composer chose one", () => {
    const withModel = codexArgv(run({ model: "gpt-5.6-sol" }), {});
    expect(withModel[withModel.indexOf("-m") + 1]).toBe("gpt-5.6-sol");
    expect(codexArgv(run(), {})).not.toContain("-m");
  });

  test("a schema brings --output-schema AND -o, because the stream cannot be trusted for it", () => {
    // openai/codex#19816: --output-schema is applied to intermediate messages
    // too, so the LAST MESSAGE FILE is the only honest place to read a report.
    const argv = codexArgv(run({ schema: { type: "object" } }), { schemaPath: "/t/s.json", outPath: "/t/o.json" });
    expect(argv[argv.indexOf("--output-schema") + 1]).toBe("/t/s.json");
    expect(argv[argv.indexOf("-o") + 1]).toBe("/t/o.json");
  });

  test("the prompt is never an argv element — codex reads it from stdin", () => {
    const argv = codexArgv(run({ prompt: "-- rm -rf /" }), {});
    expect(argv.some((a) => a.includes("rm -rf"))).toBe(false);
  });
});

describe("codex — the event stream (--json JSONL, best effort)", () => {
  test("an agent message is a text line", () => {
    expect(codexEvent(JSON.stringify({ msg: { type: "agent_message", message: "hello" } }))).toEqual({
      kind: "text",
      text: "hello",
    });
  });

  test("a command is a tool line naming the command", () => {
    const event = codexEvent(JSON.stringify({ msg: { type: "exec_command_begin", command: ["bun", "test"] } }));
    expect(event!.kind).toBe("tool");
    expect(event!.text).toContain("bun test");
  });

  test("an error is an error line", () => {
    expect(codexEvent(JSON.stringify({ msg: { type: "error", message: "no such model" } }))).toEqual({
      kind: "error",
      text: "no such model",
    });
  });

  test("reasoning and unknown events are dropped rather than shipped as noise", () => {
    expect(codexEvent(JSON.stringify({ msg: { type: "agent_reasoning", text: "hmm" } }))).toBeUndefined();
    expect(codexEvent(JSON.stringify({ msg: { type: "token_count", n: 1 } }))).toBeUndefined();
    expect(codexEvent("not json at all")).toBeUndefined();
  });
});

describe("codex — a launched run", () => {
  test("streams events, exits ok, and reads the report out of the -o file", async () => {
    const provider = codexProvider({
      launch: (opts) => {
        opts.onLine?.(JSON.stringify({ msg: { type: "agent_message", message: "done" } }));
        writeFileSync(opts.reportPath!, JSON.stringify({ verdict: "CLEAN", defects: [] }));
        return { pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 0, summary: "exit 0" }) };
      },
    });
    const launched = provider.launch(run({ role: "reviewer", schema: { type: "object" } }));

    const seen = [];
    for await (const event of launched.events) seen.push(event);
    const exit = await launched.exit;

    expect(seen).toEqual([{ kind: "text", text: "done" }]);
    expect(exit.ok).toBe(true);
    expect(exit.report).toEqual({ verdict: "CLEAN", defects: [] });
  });

  test("a report file holding prose around the JSON still yields the object", async () => {
    // openai/codex#15451: with MCP servers active the schema is ignored, and
    // what lands is the model's own text. The last balanced object in it is
    // still a better answer than failing the run.
    const provider = codexProvider({
      launch: (opts) => {
        writeFileSync(opts.reportPath!, 'here you go:\n```json\n{"verdict":"NOT_CLEAN","defects":["x"]}\n```\n');
        return { pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 0, summary: "exit 0" }) };
      },
    });
    const launched = provider.launch(run({ schema: { type: "object" } }));
    for await (const _ of launched.events) void _;
    expect((await launched.exit).report).toEqual({ verdict: "NOT_CLEAN", defects: ["x"] });
  });

  test("no report where one was demanded is not ok — the run fails closed", async () => {
    const provider = codexProvider({
      launch: () => ({ pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 0, summary: "exit 0" }) }),
    });
    const launched = provider.launch(run({ schema: { type: "object" } }));
    for await (const _ of launched.events) void _;
    const exit = await launched.exit;
    expect(exit.ok).toBe(false);
    expect(exit.summary).toContain("no structured report");
  });

  test("a non-zero exit is not ok, and the events still finish", async () => {
    const provider = codexProvider({
      launch: () => ({ pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 3, summary: "exit 3" }) }),
    });
    const launched = provider.launch(run());
    for await (const _ of launched.events) void _;
    expect(await launched.exit).toMatchObject({ ok: false, summary: "exit 3" });
  });

  test("interrupt reaches the process", async () => {
    let interrupted = false;
    let settle: (r: { code: number; summary: string }) => void = () => {};
    const provider = codexProvider({
      launch: () => ({
        pid: 1,
        interrupt: () => {
          interrupted = true;
          settle({ code: 130, summary: "cancelled" });
        },
        exited: new Promise((r) => {
          settle = r;
        }),
      }),
    });
    const launched = provider.launch(run());
    launched.interrupt();
    for await (const _ of launched.events) void _;
    expect(interrupted).toBe(true);
    expect((await launched.exit).ok).toBe(false);
  });
});

describe("codex — the model catalog", () => {
  test("slugs are projected; the instruction templates are not dumped", async () => {
    const catalog = {
      models: [
        { slug: "gpt-5.6-sol", display_name: "Sol", model_messages: { instructions_template: "x".repeat(50_000) } },
        { slug: "gpt-5.5" },
        { not_a_model: true },
      ],
    };
    const models = await codexModels(async () => ({ code: 0, stdout: JSON.stringify(catalog), stderr: "" }));
    expect(models).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  test("codex missing or unhappy advertises nothing rather than guessing", async () => {
    expect(await codexModels(async () => ({ code: 127, stdout: "", stderr: "not found" }))).toEqual([]);
    expect(await codexModels(async () => ({ code: 0, stdout: "{{{", stderr: "" }))).toEqual([]);
    expect(
      await codexModels(async () => {
        throw new Error("no codex on this machine");
      }),
    ).toEqual([]);
  });
});

describe("codex — the role prompt the daemon writes", () => {
  test("the prompt handed over on stdin opens with the role's own contract", async () => {
    let stdin = "";
    const provider = codexProvider({
      launch: (opts) => {
        stdin = opts.stdin ?? "";
        return { pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 0, summary: "exit 0" }) };
      },
    });
    const launched = provider.launch(run({ role: "reviewer", prompt: "REVIEW THIS ITEM" }));
    for await (const _ of launched.events) void _;
    await launched.exit;
    expect(stdin).toContain("REVIEW THIS ITEM");
    // The role contract comes FIRST — a prompt cannot talk the role out of it —
    // and it is the SAME `withRoleContract` claude.ts uses, verbatim.
    expect(stdin.startsWith(rolePrompt("reviewer"))).toBe(true);
    expect(stdin.indexOf("REVIEW THIS ITEM")).toBeGreaterThan(0);
  });
});

describe("codex — the raw stream is still captured on disk", () => {
  test("the log path the run named is what launch is told to write", () => {
    let path = "";
    const logPath = join(tmp(), "r1.log");
    const provider = codexProvider({
      launch: (opts) => {
        path = opts.stdoutPath;
        writeFileSync(opts.stdoutPath, "captured");
        return { pid: 1, interrupt: () => {}, exited: Promise.resolve({ code: 0, summary: "exit 0" }) };
      },
    });
    provider.launch(run({ logPath }));
    expect(path).toBe(logPath);
    expect(readFileSync(logPath, "utf8")).toBe("captured");
  });
});

// ---------------------------------------------------------- §21 codex parity

const RULES: Rules = {
  dir: "/tmp/runs/d1/rules",
  config: "/tmp/runs/d1/rules/sgconfig.yml",
  bin: "/opt/homebrew/bin/ast-grep",
  ids: ["bun-spawn-resolved-path.yml"],
  scanScript: "/tmp/runs/d1/rules/kairoku-rules-scan.sh",
};

/** A real linked worktree, because `.git` being a FILE is the whole difficulty. */
async function linkedWorktree() {
  const root = mkdtempSync(join(tmpdir(), "kairoku-codex-git-"));
  extra.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (argv: string[], cwd: string) => Bun.spawnSync(argv, { cwd, stdout: "ignore", stderr: "ignore" });
  git(["git", "init", "-q", "-b", "main"], repo);
  git(["git", "config", "user.email", "d@e.f"], repo);
  git(["git", "config", "user.name", "d"], repo);
  writeFileSync(join(repo, "a.txt"), "hi\n");
  git(["git", "add", "-A"], repo);
  git(["git", "commit", "-qm", "init"], repo);
  const wt = join(root, "wt");
  git(["git", "worktree", "add", "-q", wt, "-b", "run/x", "HEAD"], repo);
  return { repo, wt };
}

const extra: string[] = [];
afterEach(() => {
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("codex — §21 CodeGraph as an MCP server for the run", () => {
  test("an indexed run gets the codegraph table, pinned to its own worktree", () => {
    const toml = codexConfigToml(
      run({ cwd: "/tmp/wt/r1", codegraph: { bin: "/opt/homebrew/bin/codegraph", worktree: "/tmp/wt/r1" } }),
    );
    expect(toml).toContain("[mcp_servers.codegraph]");
    expect(toml).toContain('command = "/opt/homebrew/bin/codegraph"');
    expect(toml).toContain('args = ["serve", "--mcp", "-p", "/tmp/wt/r1"]');
  });

  test("a run without the index gets no codegraph table", () => {
    expect(codexConfigToml(run())).not.toContain("mcp_servers.codegraph");
  });
});

describe("codex — §21 the per-run project config", () => {
  test("the MCP entry names the ENV VAR and never a token, and points at the run's own app", () => {
    const toml = codexConfigToml(run({ env: { KAIROKU_PAT: "kai_secret_value", KAIROKU_URL: "https://kairoku.io" } }));
    expect(toml).toContain("[mcp_servers.kairoku]");
    expect(toml).toContain('url = "https://kairoku.io/api/mcp"');
    expect(toml).toContain('bearer_token_env_var = "KAIROKU_PAT"');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).not.toContain("kai_secret_value");
  });

  test("no app origin in the run's environment writes no MCP entry rather than a guessed one", () => {
    const toml = codexConfigToml(run());
    expect(toml).not.toContain("[mcp_servers.kairoku]");
  });

  test("the hooks file runs the materialised scan script on Write|Edit", () => {
    const hooks = JSON.parse(codexHooksJson(RULES)) as {
      hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.PostToolUse[0]!.matcher).toBe("Write|Edit");
    expect(hooks.hooks.PostToolUse[0]!.hooks[0]!.type).toBe("command");
    expect(hooks.hooks.PostToolUse[0]!.hooks[0]!.command).toContain(RULES.scanScript);
  });

  test("both files are written fresh into the worktree and EXCLUDED from the diff", async () => {
    const { repo, wt } = await linkedWorktree();
    writeCodexFiles(run({ cwd: wt, env: { KAIROKU_PAT: "p", KAIROKU_URL: "https://kairoku.io" }, rules: RULES }));
    expect(readFileSync(join(wt, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.kairoku]");
    expect(readFileSync(join(wt, ".codex", "hooks.json"), "utf8")).toContain("PostToolUse");
    // git resolves a linked worktree's info/exclude to the COMMON dir.
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".codex/");
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: wt, stdout: "pipe", stderr: "ignore" });
    expect(new TextDecoder().decode(status.stdout)).toBe("");
  });

  test("writing twice does not duplicate the exclude line", async () => {
    const { repo, wt } = await linkedWorktree();
    const r = run({ cwd: wt, env: { KAIROKU_PAT: "p" }, rules: RULES });
    writeCodexFiles(r);
    writeCodexFiles(r);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === ".codex/")).toHaveLength(1);
  });

  test("no rules writes no hooks file — nothing to run, nothing to trust", async () => {
    const { wt } = await linkedWorktree();
    writeCodexFiles(run({ cwd: wt, env: { KAIROKU_PAT: "p", KAIROKU_URL: "https://kairoku.io" } }));
    expect(existsSync(join(wt, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(wt, ".codex", "config.toml"))).toBe(true);
  });
});

describe("codex — §21 the trust the project config needs", () => {
  test("the project is trusted per invocation, so its .codex/config.toml is loaded at all", () => {
    const argv = codexArgv(run({ cwd: "/tmp/wt" }), {});
    expect(argv).toContain('projects."/tmp/wt".trust_level="trusted"');
  });

  test("a path with a quote or a backslash in it is escaped, not injected", () => {
    const argv = codexArgv(run({ cwd: '/tmp/w"t\\x' }), {});
    expect(argv).toContain('projects."/tmp/w\\"t\\\\x".trust_level="trusted"');
  });

  test("hook trust is bypassed ONLY when this daemon wrote a hook to run", () => {
    expect(codexArgv(run({ rules: RULES }), {})).toContain("--dangerously-bypass-hook-trust");
    expect(codexArgv(run(), {})).not.toContain("--dangerously-bypass-hook-trust");
  });
});
