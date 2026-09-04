import { describe, expect, test } from "bun:test";
import { CODEGRAPH_NOTE, type CodeGraph } from "../codegraph";
import { rolePrompt } from "../roles";
import type { Rules } from "../rules";
import { claudeProvider, claudeQueryOptions, postToolUseHook, preToolUseHook } from "./claude";
import type { RoleRun } from "./types";

const run = (over: Partial<RoleRun> = {}): RoleRun => ({
  dispatchId: "d1",
  runId: "r1",
  role: "implementer",
  prompt: "build the thing",
  cwd: "/tmp/wt/r1",
  env: { KAIROKU_PAT: "pat" },
  timeoutMs: 60_000,
  logPath: "/tmp/wt/r1.log",
  ...over,
});

/** A fake `query()`: the messages to yield, plus the control surface. */
function fakeQuery(messages: unknown[], onInterrupt?: () => void) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const query = (params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    const iterator = (async function* () {
      for (const message of messages) yield message;
    })();
    return Object.assign(iterator, {
      interrupt: async () => {
        onInterrupt?.();
      },
      supportedModels: async () => [{ value: "claude-opus-5" }, { value: "claude-sonnet-5" }],
    });
  };
  return { query, calls };
}

const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "all done",
  session_id: "sess-1",
  ...over,
});

const CODEGRAPH: CodeGraph = { bin: "/opt/homebrew/bin/codegraph", worktree: "/tmp/wt/r1" };

describe("claude — §21 CodeGraph as an MCP server for the run", () => {
  test("an indexed run gets the server, pinned to its own worktree", () => {
    const options = claudeQueryOptions(run({ codegraph: CODEGRAPH }), {});
    expect(options.mcpServers).toEqual({
      codegraph: {
        type: "stdio",
        command: "/opt/homebrew/bin/codegraph",
        args: ["serve", "--mcp", "-p", "/tmp/wt/r1"],
      },
    });
  });

  test("a run without the index gets NO mcpServers option at all", () => {
    expect(claudeQueryOptions(run(), {})).not.toHaveProperty("mcpServers");
  });

  test("the tool is named in the prompt only when it is actually there", async () => {
    const { query, calls } = fakeQuery([result()]);
    const read = async (index: number): Promise<string> => {
      const sent: Array<{ message: { content: string } }> = [];
      for await (const m of calls[index]!.prompt as AsyncIterable<{ message: { content: string } }>) sent.push(m);
      return sent[0]!.message.content;
    };

    await claudeProvider({ query }).launch(run({ codegraph: CODEGRAPH })).exit;
    expect(await read(0)).toContain(CODEGRAPH_NOTE);

    await claudeProvider({ query }).launch(run()).exit;
    expect(await read(1)).not.toContain(CODEGRAPH_NOTE);
  });
});

describe("claude — the options the SDK is handed (§20 item 1)", () => {
  test("the worktree is the cwd and the plugin arrives as a local plugin, not a setting source", () => {
    const options = claudeQueryOptions(run(), { pluginPath: "/opt/kairoku/plugin", claudePath: "/usr/bin/claude" });
    expect(options.cwd).toBe("/tmp/wt/r1");
    expect(options.plugins).toEqual([{ type: "local", path: "/opt/kairoku/plugin" }]);
    expect(options).not.toHaveProperty("settingSources");
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/bin/claude");
  });

  test("permission mode and allowed tools come from the role policy", () => {
    expect(claudeQueryOptions(run({ role: "implementer" }), {}).permissionMode).toBe("acceptEdits");
    const reviewer = claudeQueryOptions(run({ role: "reviewer" }), {});
    expect(reviewer.permissionMode).toBe("dontAsk");
    expect(reviewer.allowedTools).toContain("Read");
    expect(reviewer.allowedTools).not.toContain("Write");
  });

  test("a PreToolUse hook is always installed, with no matcher, so it cannot be shadowed", () => {
    // canUseTool is LAST in the permission chain and loses to a bypass or allow
    // rule; a PreToolUse deny wins even under bypassPermissions.
    const hooks = claudeQueryOptions(run(), {}).hooks as { PreToolUse?: Array<{ matcher?: string; hooks: unknown[] }> };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse![0]!.matcher).toBeUndefined();
    expect(hooks.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(claudeQueryOptions(run(), {})).not.toHaveProperty("canUseTool");
  });

  test("a schema becomes outputFormat json_schema; no schema, no outputFormat", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    expect(claudeQueryOptions(run({ schema }), {}).outputFormat).toEqual({ type: "json_schema", schema });
    expect(claudeQueryOptions(run(), {})).not.toHaveProperty("outputFormat");
  });

  test("allowedTools for a reviewer run with a schema contains StructuredOutput", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const options = claudeQueryOptions(run({ role: "reviewer", schema }), {});
    expect(options.allowedTools).toContain("StructuredOutput");
  });

  test("model and effort are passed only when the composer chose them", () => {
    const chosen = claudeQueryOptions(run({ model: "claude-opus-5", effort: "high" }), {});
    expect(chosen.model).toBe("claude-opus-5");
    expect(chosen.effort).toBe("high");
    const bare = claudeQueryOptions(run(), {});
    expect(bare).not.toHaveProperty("model");
    expect(bare).not.toHaveProperty("effort");
  });
});

describe("claude — the hook enforces the policy unconditionally", () => {
  test("an allowed tool passes with an empty answer", async () => {
    const denials: string[] = [];
    const hook = preToolUseHook(run(), (reason) => denials.push(reason));
    expect(await hook({ tool_name: "Read", tool_input: { file_path: "/tmp/wt/r1/a.ts" } })).toEqual({});
    expect(denials).toEqual([]);
  });

  test("a denied tool carries the reason to the model AND raises a deny event", async () => {
    const denials: string[] = [];
    const hook = preToolUseHook(run({ role: "reviewer" }), (reason) => denials.push(reason));
    const answer = (await hook({ tool_name: "Write", tool_input: { file_path: "/tmp/wt/r1/a.ts" } })) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(answer.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toBe("the reviewer may not use Write");
    expect(denials).toEqual(["the reviewer may not use Write"]);
  });

  test("a write outside the worktree is denied even for the implementer", async () => {
    const hook = preToolUseHook(run(), () => {});
    const answer = (await hook({ tool_name: "Write", tool_input: { file_path: "/etc/passwd" } })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a reviewer with a schema is allowed to call StructuredOutput", async () => {
    // Production, 2026-09-03: this call was denied ("the reviewer may not use
    // StructuredOutput"), so the reviewer's verdict never reached the daemon.
    const denials: string[] = [];
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const hook = preToolUseHook(run({ role: "reviewer", schema }), (reason) => denials.push(reason));
    const answer = await hook({
      tool_name: "StructuredOutput",
      tool_input: { verdict: "NOT_CLEAN", defects: [] },
    });
    expect(answer).toEqual({});
    expect(denials).toEqual([]);
  });
});

describe("claude — a launched run", () => {
  test("assistant text and tool calls become curated events; the tool line is summarised", async () => {
    const { query } = fakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" },
      assistant([
        { type: "text", text: "reading the item" },
        { type: "tool_use", name: "Bash", input: { command: "x".repeat(400) } },
      ]),
      result(),
    ]);
    const launched = claudeProvider({ query }).launch(run());

    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen).toEqual([
      { kind: "text", text: "reading the item" },
      { kind: "tool", text: expect.stringContaining("Bash ") },
    ]);
    expect(seen[1]!.text.length).toBeLessThanOrEqual(206);
  });

  test("a success result is ok and carries the session id", async () => {
    const { query } = fakeQuery([result()]);
    const launched = claudeProvider({ query }).launch(run());
    for await (const _ of launched.events) void _;
    expect(await launched.exit).toMatchObject({ ok: true, sessionId: "sess-1", summary: "all done" });
  });

  test("the structured report is read from the result, never from the prose", async () => {
    const { query } = fakeQuery([
      assistant([{ type: "text", text: '{"verdict":"CLEAN"} — trust me' }]),
      result({ structured_output: { verdict: "NOT_CLEAN", defects: ["a.ts leaks a handle"] } }),
    ]);
    const launched = claudeProvider({ query }).launch(run({ role: "reviewer", schema: { type: "object" } }));
    for await (const _ of launched.events) void _;
    expect((await launched.exit).report).toEqual({ verdict: "NOT_CLEAN", defects: ["a.ts leaks a handle"] });
  });

  test("a demanded report that never came fails the run closed", async () => {
    const { query } = fakeQuery([result()]);
    const launched = claudeProvider({ query }).launch(run({ schema: { type: "object" } }));
    for await (const _ of launched.events) void _;
    const exit = await launched.exit;
    expect(exit.ok).toBe(false);
    expect(exit.summary).toContain("no structured report");
  });

  test("an error result is not ok and says why", async () => {
    const { query } = fakeQuery([result({ subtype: "error_during_execution", is_error: true, result: undefined })]);
    const launched = claudeProvider({ query }).launch(run());
    for await (const _ of launched.events) void _;
    expect(await launched.exit).toMatchObject({ ok: false, summary: expect.stringContaining("error_during_execution") });
  });

  test("a throw out of the SDK is an exit, not an unhandled rejection", async () => {
    const query = () =>
      Object.assign(
        (async function* () {
          throw new Error("claude is not installed");
        })(),
        { interrupt: async () => {}, supportedModels: async () => [] },
      );
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    const exit = await launched.exit;
    expect(exit.ok).toBe(false);
    expect(exit.summary).toContain("claude is not installed");
    expect(seen.at(-1)).toEqual({ kind: "error", text: expect.stringContaining("claude is not installed") });
  });

  test("interrupt reaches the SDK's own interrupt", async () => {
    let interrupted = false;
    const { query } = fakeQuery([result()], () => {
      interrupted = true;
    });
    const launched = claudeProvider({ query }).launch(run());
    launched.interrupt();
    for await (const _ of launched.events) void _;
    await launched.exit;
    expect(interrupted).toBe(true);
  });

  test("the prompt goes in as a streaming input, which is what supportedModels needs", async () => {
    const { query, calls } = fakeQuery([result()]);
    const launched = claudeProvider({ query }).launch(run());
    for await (const _ of launched.events) void _;
    await launched.exit;
    const prompt = calls[0]!.prompt as AsyncIterable<{ type: string; message: { content: string } }>;
    expect(typeof (prompt as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe("function");
    const sent: unknown[] = [];
    for await (const message of prompt) sent.push(message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "user", parent_tool_use_id: null, session_id: "" });
    expect((sent[0] as { message: { role: string; content: string } }).message.role).toBe("user");
    expect((sent[0] as { message: { content: string } }).message.content).toContain("build the thing");
  });

  test("the role contract leads EVERY prompt, exactly as it does on codex (SPEC.md:175)", async () => {
    // The stated safety net for a machine with no plugin is that the role
    // survives anyway. It only exists if it is on BOTH providers: claude is the
    // default for every role, so a claude-only omission is the whole net gone.
    const { query, calls } = fakeQuery([result()]);
    const launched = claudeProvider({ query }).launch(run({ role: "reviewer", prompt: "REVIEW THIS ITEM" }));
    for await (const _ of launched.events) void _;
    await launched.exit;
    const sent: Array<{ message: { content: string } }> = [];
    for await (const message of calls[0]!.prompt as AsyncIterable<{ message: { content: string } }>) sent.push(message);
    expect(sent[0]!.message.content.startsWith(rolePrompt("reviewer"))).toBe(true);
    expect(sent[0]!.message.content.indexOf("REVIEW THIS ITEM")).toBeGreaterThan(0);
  });
});

/**
 * §23.4 — the tool cards' status line. The SDK answers an assistant's `tool_use`
 * blocks with a USER-turn message of `tool_result` blocks, so this is where the
 * transcript learns whether a call worked and how long it took.
 */
describe("claude — tool results (§23.4)", () => {
  const toolResult = (over: Record<string, unknown>) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", ...over }] },
    parent_tool_use_id: null,
    session_id: "sess-1",
  });

  test("a tool_use answered by a tool_result yields tool then result, with the elapsed ms", async () => {
    const messages = [
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test" } }]),
      toolResult({ tool_use_id: "toolu_1", content: [{ type: "text", text: "\n615 pass\n0 fail\n" }] }),
      result(),
    ];
    // A real gap between the call and its answer, so the duration is an elapsed
    // measurement rather than a constant that happens to parse.
    const query = () =>
      Object.assign(
        (async function* () {
          yield messages[0];
          await Bun.sleep(15);
          yield messages[1];
          yield messages[2];
        })(),
        { interrupt: async () => {}, supportedModels: async () => [] },
      );
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen.map((e) => e.kind)).toEqual(["tool", "result"]);
    expect(seen[1]!.text).toMatch(/^ok \d+ms 615 pass$/);
    expect(Number(/^ok (\d+)ms/.exec(seen[1]!.text)![1])).toBeGreaterThanOrEqual(10);
  });

  test("is_error reads error, and the word carries it — never the colour alone", async () => {
    const { query } = fakeQuery([
      assistant([{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "bun test" } }]),
      toolResult({ tool_use_id: "toolu_9", is_error: true, content: "  \nexit 1: 2 fail\nat a.test.ts:12" }),
      result(),
    ]);
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen[1]).toEqual({ kind: "result", text: expect.stringMatching(/^error \d+ms exit 1: 2 fail$/) });
  });

  test("results come back in the order the calls were made, which is how the app pairs them", async () => {
    const { query } = fakeQuery([
      assistant([
        { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "/b.ts" } },
      ]),
      toolResult({ tool_use_id: "toolu_a", content: "a" }),
      toolResult({ tool_use_id: "toolu_b", content: "b" }),
      result(),
    ]);
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen.map((e) => e.kind)).toEqual(["tool", "tool", "result", "result"]);
    expect(seen[2]!.text).toContain("a");
    expect(seen[3]!.text).toContain("b");
  });

  test("a result for a call this run never emitted is dropped, so a replay cannot mis-pair", async () => {
    // The app pairs a result with the OLDEST call still waiting (FIFO). A
    // second copy of an answer — a replayed user turn, a resumed session — would
    // therefore attach itself to some LATER call and describe the wrong one.
    const { query } = fakeQuery([
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
      toolResult({ tool_use_id: "toolu_1", content: "one" }),
      toolResult({ tool_use_id: "toolu_1", content: "one" }),
      toolResult({ tool_use_id: "toolu_unknown", content: "not ours" }),
      result(),
    ]);
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen.map((e) => e.kind)).toEqual(["tool", "result"]);
  });

  test("the user turn that carries the prompt is not a result", async () => {
    const { query } = fakeQuery([
      { type: "user", message: { role: "user", content: "build the thing" }, parent_tool_use_id: null },
      result(),
    ]);
    const launched = claudeProvider({ query }).launch(run());
    const seen = [];
    for await (const event of launched.events) seen.push(event);
    expect(seen).toEqual([]);
  });
});

describe("claude — the model list", () => {
  test("supportedModels is projected to values", async () => {
    const { query } = fakeQuery([]);
    expect(await claudeProvider({ query }).models()).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  test("no claude on this machine advertises nothing rather than guessing", async () => {
    const query = () => {
      throw new Error("spawn claude ENOENT");
    };
    expect(await claudeProvider({ query: query as never }).models()).toEqual([]);
  });
});

// ---------------------------------------------------------------- §21 layer one

const RULES: Rules = {
  dir: "/tmp/runs/d1/rules",
  config: "/tmp/runs/d1/rules/sgconfig.yml",
  bin: "/opt/homebrew/bin/ast-grep",
  ids: ["bun-spawn-resolved-path.yml"],
  scanScript: "/tmp/runs/d1/rules/kairoku-rules-scan.sh",
};

const MATCH = {
  ruleId: "bun-spawn-resolved-path",
  file: "src/a.ts",
  line: 12,
  message: "Bun.spawn must run the path Bun.which resolved.",
  note: "CLI PR #7 defect 5.",
};

describe("claude — §21 layer one: the hook at the write", () => {
  test("a PostToolUse hook on Write|Edit is installed beside the policy hook, only when rules exist", () => {
    const withRules = claudeQueryOptions(run({ rules: RULES }), {}).hooks as {
      PreToolUse?: unknown[];
      PostToolUse?: Array<{ matcher?: string; hooks: unknown[] }>;
    };
    expect(withRules.PreToolUse).toHaveLength(1);
    expect(withRules.PostToolUse).toHaveLength(1);
    expect(withRules.PostToolUse![0]!.matcher).toBe("Write|Edit");

    const without = claudeQueryOptions(run(), {}).hooks as Record<string, unknown>;
    expect(without.PostToolUse).toBeUndefined();
  });

  test("a write that matches a rule returns the SDK's blocking result with the message AND the note", async () => {
    const hook = postToolUseHook(run({ rules: RULES }), async () => ({ ok: true, matches: [MATCH] }));
    const answer = (await hook({
      tool_name: "Write",
      tool_input: { file_path: "/tmp/wt/r1/src/a.ts" },
    })) as { decision?: string; reason?: string };
    expect(answer.decision).toBe("block");
    expect(answer.reason).toContain("bun-spawn-resolved-path");
    expect(answer.reason).toContain("src/a.ts:12");
    expect(answer.reason).toContain("Bun.spawn must run the path");
    expect(answer.reason).toContain("CLI PR #7 defect 5.");
  });

  test("a write that matches nothing passes with an empty answer", async () => {
    const hook = postToolUseHook(run({ rules: RULES }), async () => ({ ok: true, matches: [] }));
    expect(await hook({ tool_name: "Write", tool_input: { file_path: "/tmp/wt/r1/src/a.ts" } })).toEqual({});
  });

  test("a file OUTSIDE the worktree is ignored, and is never even scanned", async () => {
    let scanned = 0;
    const hook = postToolUseHook(run({ rules: RULES }), async () => {
      scanned++;
      return { ok: true as const, matches: [MATCH] };
    });
    expect(await hook({ tool_name: "Write", tool_input: { file_path: "/etc/hosts" } })).toEqual({});
    expect(await hook({ tool_name: "Write", tool_input: {} })).toEqual({});
    expect(scanned).toBe(0);
  });

  test("a scan this daemon cannot read does NOT block — QA is the gate of record", async () => {
    const hook = postToolUseHook(run({ rules: RULES }), async () => ({ ok: false as const, error: "ast-grep died" }));
    expect(await hook({ tool_name: "Write", tool_input: { file_path: "/tmp/wt/r1/src/a.ts" } })).toEqual({});
  });

  test("the hook scans the WRITTEN FILE, in the worktree, with the run's rules", async () => {
    const calls: Array<{ rules: Rules; cwd: string; paths: string[] }> = [];
    const hook = postToolUseHook(run({ rules: RULES }), async (rules, cwd, paths) => {
      calls.push({ rules, cwd, paths });
      return { ok: true, matches: [] };
    });
    await hook({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(calls).toEqual([{ rules: RULES, cwd: "/tmp/wt/r1", paths: ["/tmp/wt/r1/src/a.ts"] }]);
  });
});
