import { describe, expect, test } from "bun:test";
import { claudeProvider, claudeQueryOptions, preToolUseHook } from "./claude";
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
    expect(sent).toEqual([
      { type: "user", message: { role: "user", content: "build the thing" }, parent_tool_use_id: null, session_id: "" },
    ]);
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
