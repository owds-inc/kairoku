/**
 * The Claude provider — THE ONLY MODULE IN THIS REPO THAT IMPORTS THE AGENT SDK
 * (§20.2, which amends SPEC's zero-dependency rule to name exactly this one).
 * `constraints.test.ts` asserts both halves: the package list is that one entry,
 * and no other file may import it.
 *
 * The SDK arrives through a seam (`deps.query`) rather than being called
 * directly, and that is not decoration: every behaviour below — the options, the
 * hook, the event mapping, the fail-closed report — is tested against a fake
 * `query`, so the only line in this file no test covers is the default binding.
 *
 * Four facts about the SDK shape this file, all verified against 0.3.259 and
 * `planning/orchestration-facts.md`:
 *
 *   1. `canUseTool` is LAST in the permission chain and is shadowed by a bypass
 *      or allow rule. A `PreToolUse` hook runs FIRST and its deny wins even
 *      under `bypassPermissions`. So the gate is a hook, with no matcher.
 *   2. A plugin does NOT arrive via `settingSources`; it is
 *      `plugins: [{ type: 'local', path }]`.
 *   3. `supportedModels()` is a control request and needs STREAMING-INPUT mode,
 *      which is why the prompt is an async iterable of one user message rather
 *      than a string.
 *   4. Structured output lands on the RESULT message as `structured_output`,
 *      never in the assistant prose — a report read out of the text is a report
 *      a model can fake, and §20.4 fails the run closed without a real one.
 *
 * And one fact about US rather than the SDK: the prompt that goes in is
 * `withRoleContract(role, prompt)`, the SAME helper codex uses. The plugin
 * carries the role AGENTS; the contract in the prompt is what survives a
 * machine where the plugin did not load.
 */

import { isAbsolute, resolve } from "node:path";
import { POLICY, decide, insideWorktree, toolSummary } from "../policy";
import { withRoleContract } from "../roles";
import { formatMatches, scanRules, type Rules, type ScanResult } from "../rules";
import type { LaunchedRun, Provider, ProviderEvent, RoleRun } from "./types";

/**
 * The slice of the SDK this file uses, restated so the seam is typed without
 * the tests needing the real package.
 */
export interface ClaudeQueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<Array<{ value: string }>>;
}

export type ClaudeQuery = (params: {
  prompt: AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}) => ClaudeQueryHandle;

export interface ClaudeDeps {
  readonly query?: ClaudeQuery;
  /** The plugin directory this binary ships, or the user's installed copy. */
  readonly pluginPath?: string;
  /** The resolved `claude` on this machine; the SDK's bundled one when absent. */
  readonly claudePath?: string;
}

export type HookAnswer = Record<string, unknown>;
export type HookInput = { tool_name?: unknown; tool_input?: unknown };
export type PreToolUseHook = (input: HookInput) => Promise<HookAnswer>;
export type PostToolUseHook = (input: HookInput) => Promise<HookAnswer>;

/**
 * The unconditional gate. A denial answers the MODEL with the reason (so it can
 * correct itself) and raises a `deny` EVENT (so a human can see what it tried) —
 * §20.8's "every denial is a deny event", in one place.
 */
export function preToolUseHook(run: RoleRun, onDeny: (reason: string) => void): PreToolUseHook {
  return async (input) => {
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    const decision = decide({ role: run.role, tool, input: input.tool_input, worktree: run.cwd });
    if (decision.allow) return {};
    onDeny(decision.reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  };
}

/**
 * §21 layer one — the hook AT THE WRITE.
 *
 * `PostToolUse` on `Write|Edit`, so ast-grep runs on the real file after the
 * write and no temp-file reconstruction is needed (§21 Q24). "Block" means the
 * AGENT is stopped, not the disk: the SDK feeds `reason` back and the turn
 * continues, which is the whole point — the implementer gets the rule's message
 * and the defect it exists for while the fix is still one edit away.
 *
 * IT IS THE FAST SIGNAL, NOT THE GATE (§21 Q11). Three things pass silently
 * here and are caught by QA instead: a file outside the worktree (not this
 * run's to judge), a file no rule's language parses (ast-grep simply matches
 * nothing), and a scan this daemon cannot read. The last one is deliberate — a
 * hook that blocked every write because the scanner broke would burn the run's
 * whole budget on a machine fault, and `qa.ts` fails closed on exactly that
 * condition one layer down.
 */
export function postToolUseHook(
  run: RoleRun,
  scan: (rules: Rules, cwd: string, paths: string[]) => Promise<ScanResult> = scanRules,
): PostToolUseHook {
  return async (input) => {
    const rules = run.rules;
    const target = (input.tool_input as { file_path?: unknown } | null)?.file_path;
    if (!rules || typeof target !== "string" || target === "") return {};
    if (!insideWorktree(run.cwd, target)) return {};

    const path = isAbsolute(target) ? resolve(target) : resolve(run.cwd, target);
    const result = await scan(rules, run.cwd, [path]);
    if (!result.ok || result.matches.length === 0) return {};
    return {
      decision: "block",
      reason: `The repo's own rules refuse this write:\n\n${formatMatches(result.matches)}`,
    };
  };
}

/** Everything handed to `query({ options })`, built from the role and the run. */
export function claudeQueryOptions(
  run: RoleRun,
  deps: ClaudeDeps,
  onDeny: (reason: string) => void = () => {},
): Record<string, unknown> {
  const policy = POLICY[run.role];
  return {
    cwd: run.cwd,
    env: run.env,
    permissionMode: policy.permissionMode,
    allowedTools: [...policy.allowedTools],
    // No matcher on PreToolUse: every tool call of every kind goes through the
    // policy. PostToolUse is matched to `Write|Edit` because it exists to read
    // what was just written, and only appears when the repo declares rules.
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook(run, onDeny)] }],
      ...(run.rules === undefined ? {} : { PostToolUse: [{ matcher: "Write|Edit", hooks: [postToolUseHook(run)] }] }),
    },
    ...(deps.pluginPath === undefined ? {} : { plugins: [{ type: "local", path: deps.pluginPath }] }),
    ...(deps.claudePath === undefined ? {} : { pathToClaudeCodeExecutable: deps.claudePath }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(run.effort === undefined ? {} : { effort: run.effort }),
    ...(run.schema === undefined ? {} : { outputFormat: { type: "json_schema", schema: run.schema } }),
  };
}

/**
 * One user message, as a stream. Streaming-input mode is what makes the control
 * requests (`interrupt`, `supportedModels`) available at all.
 */
async function* oneTurn(prompt: string): AsyncIterable<unknown> {
  yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
}

/**
 * The SDK, imported lazily.
 *
 * Lazy so that a machine with no Claude side still starts, doctors and runs
 * codex work: the import is the only thing in the daemon that pulls a package
 * tree, and a daemon that cannot import it should say so on the run that needed
 * it rather than failing to boot.
 *
 * NOT memoised. `import()` is already cached by the module registry, so a memo
 * here bought nothing and cost the one thing that matters: it pinned the first
 * `query` this process ever saw, which is what made `productionProviders` look
 * untestable — a test cannot substitute a module a closure already captured.
 */
async function sdkQuery(): Promise<ClaudeQuery> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as { query: unknown };
  return sdk.query as ClaudeQuery;
}

export function claudeProvider(deps: ClaudeDeps = {}): Provider {
  const open = async (params: Parameters<ClaudeQuery>[0]): Promise<ClaudeQueryHandle> =>
    (deps.query ?? (await sdkQuery()))(params);

  return {
    name: "claude",

    async models(): Promise<string[]> {
      try {
        const handle = await open({ prompt: (async function* () {})(), options: claudeQueryOptions(probeRun(), deps) });
        const models = await handle.supportedModels();
        await handle.interrupt().catch(() => {});
        return models.map((m) => m.value).filter((v) => typeof v === "string" && v !== "");
      } catch {
        // No claude, no login, no answer: advertise nothing. The composer greys
        // out what no machine offers, which is better than a guess it cannot run.
        return [];
      }
    },

    launch(run: RoleRun): LaunchedRun {
      const queue: ProviderEvent[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const emit = (event: ProviderEvent) => {
        queue.push(event);
        wake?.();
      };

      let handle: ClaudeQueryHandle | undefined;
      let interruptWanted = false;
      let sessionId: string | undefined;
      let report: unknown;
      let outcome: { ok: boolean; summary: string } = { ok: false, summary: "the session ended without a result" };

      const pump = (async () => {
        try {
          handle = await open({
            prompt: oneTurn(withRoleContract(run.role, run.prompt)),
            options: claudeQueryOptions(run, deps, (reason) => emit({ kind: "deny", text: reason })),
          });
          if (interruptWanted) await handle.interrupt().catch(() => {});
          for await (const message of handle) {
            const parsed = message as Record<string, unknown>;
            if (typeof parsed.session_id === "string" && parsed.session_id !== "") sessionId = parsed.session_id;
            if (parsed.type === "assistant") {
              for (const event of assistantEvents(parsed)) emit(event);
            } else if (parsed.type === "result") {
              report = parsed.structured_output;
              outcome = resultOutcome(parsed);
            }
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          emit({ kind: "error", text });
          outcome = { ok: false, summary: text };
        } finally {
          closed = true;
          wake?.();
        }
      })();

      const exit = pump.then(() => {
        if (run.schema && report === undefined) {
          return {
            ok: false,
            summary: `${outcome.summary}, and no structured report came back — the run fails closed (§20.4)`,
            ...(sessionId === undefined ? {} : { sessionId }),
          };
        }
        return {
          ...outcome,
          ...(report === undefined ? {} : { report }),
          ...(sessionId === undefined ? {} : { sessionId }),
        };
      });

      return {
        events: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length) yield queue.shift()!;
              if (closed) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
          },
        },
        interrupt() {
          // An interrupt can arrive before the session exists; the flag is what
          // makes that case land rather than being lost.
          interruptWanted = true;
          void handle?.interrupt().catch(() => {});
        },
        exit,
      };
    },
  };
}

/** Text blocks and tool calls; everything else in an assistant message is not a log line. */
function assistantEvents(message: Record<string, unknown>): ProviderEvent[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const events: ProviderEvent[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      events.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      events.push({ kind: "tool", text: toolSummary(block.name, block.input) });
    }
  }
  return events;
}

function resultOutcome(message: Record<string, unknown>): { ok: boolean; summary: string } {
  const subtype = typeof message.subtype === "string" ? message.subtype : "unknown";
  const ok = subtype === "success" && message.is_error !== true;
  const text = typeof message.result === "string" && message.result !== "" ? message.result : subtype;
  return { ok, summary: ok ? text : `${subtype}: ${text}` };
}

/** A throwaway run, only ever used to open a session long enough to ask what it can drive. */
function probeRun(): RoleRun {
  return {
    dispatchId: "models",
    runId: "models",
    role: "reviewer",
    prompt: "",
    cwd: process.cwd(),
    env: {},
    timeoutMs: 30_000,
    logPath: "",
  };
}
