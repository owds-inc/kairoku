import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolePrompt } from "../roles";
import { codexArgv, codexEvent, codexModels, codexProvider } from "./codex";
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
