/**
 * The Codex provider — `codex exec --json`, run to completion (§20.2).
 *
 * Verified against codex-cli 0.151.0. Three upstream bugs shape this file more
 * than anything else does, and each one is designed around rather than hoped
 * about:
 *
 *   openai/codex#19816 — `--output-schema` is applied to INTERMEDIATE agent
 *     messages, not only the final one. So the report is read from the
 *     `-o/--output-last-message` FILE, never from the event stream.
 *   openai/codex#15451 — `--json` and `--output-schema` are reportedly ignored
 *     while MCP servers are active, which is always for us. So the report file
 *     is parsed leniently: valid JSON first, otherwise the last balanced object
 *     inside whatever prose landed there.
 *   openai/codex#4181 — a model_family guard once limited the schema to gpt-5.
 *     Nothing to do but fail closed when no report arrives, which is item 3 of
 *     §20.4 anyway.
 *
 * The sandbox mode is DERIVED FROM `policy.ts`, never passed in: one table
 * decides what a role may do and both providers read it.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEGRAPH_NOTE, codegraphTomlTable } from "../codegraph";
import { resultText } from "../events";
import { launch as procLaunch } from "../proc";
import { withRoleContract } from "../roles";
import type { RoleName } from "../policy";
import type { Rules } from "../rules";
import { excludeFromGit, run as execArgv } from "../worktree";
import type { LaunchedRun, Provider, ProviderEvent, RoleRun } from "./types";

/** `read-only` still runs commands; it only refuses writes — which IS §20.8's "read + run". */
const SANDBOX: Record<RoleName, "workspace-write" | "read-only"> = {
  implementer: "workspace-write",
  reviewer: "read-only",
  planner: "read-only",
  researcher: "read-only",
};

export interface CodexPaths {
  readonly schemaPath?: string;
  readonly outPath?: string;
}

/**
 * §15 of the Codex surfaces fact: a project's own `.codex/config.toml` is read
 * ONLY if the project is trusted, and trust cannot be self-declared from inside
 * it — that is precisely what stops a cloned repo loosening its own sandbox. So
 * the daemon trusts the worktree as a SESSION FLAG, per invocation, rather than
 * writing `[projects]` into `~/.codex/config.toml`: the run gets its config and
 * the machine keeps none of it. Escaped the way codex escapes it itself
 * (`config_update.rs`), so a path with a quote in it cannot inject a key.
 */
function trustFlag(cwd: string): string {
  const key = cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `projects."${key}".trust_level="trusted"`;
}

export function codexArgv(run: RoleRun, paths: CodexPaths): string[] {
  const argv = [
    "codex",
    "exec",
    "--json",
    "-s",
    SANDBOX[run.role],
    "-c",
    'approval_policy="never"',
    "-c",
    trustFlag(run.cwd),
    "-C",
    run.cwd,
  ];
  // Only when this daemon actually wrote a hook. The flag is documented as "for
  // automation that already vets hook sources", which is true of a file we
  // generated a moment ago and of nothing else.
  if (run.rules) argv.push("--dangerously-bypass-hook-trust");
  if (run.model) argv.push("-m", run.model);
  if (run.schema && paths.schemaPath && paths.outPath) {
    argv.push("--output-schema", paths.schemaPath, "-o", paths.outPath);
  }
  // The prompt is NOT a positional argument: codex reads it from stdin when
  // none is given, which keeps it out of `ps` and stops a prompt beginning with
  // `-` being read as a flag.
  return argv;
}

// ------------------------------------------------- §21 the per-run project config
//
// Codex has no plugin agents and no bundleable hooks, so everything Claude gets
// from the plugin the daemon writes into the worktree instead — fresh per run,
// and excluded from the diff so the agent cannot commit the daemon's plumbing.

export const CODEX_DIR = ".codex";

/** The paths written per run. Also the lines added to the checkout's exclude. */
export const CODEX_FILES = [`${CODEX_DIR}/`] as const;

/**
 * The project layer.
 *
 * THE MCP CREDENTIAL LIVES HERE NOW, NOT ON THE MACHINE (§21 item 5b). A
 * machine-wide `[mcp_servers.kairoku]` with `bearer_token_env_var` breaks the
 * operator's OWN interactive Codex: `KAIROKU_PAT` is only ever set inside a run,
 * Codex prefers the bearer path once the var is configured, and the human's
 * session gets `401 No authorization provided` while its own OAuth login is
 * ignored. Per run, the var IS set, and nothing outside the run is touched.
 *
 * It names the VARIABLE, never a value — a token in a file in a git worktree is
 * a token in a commit one `git add -A` later.
 */
export function codexConfigToml(run: RoleRun): string {
  const lines = ["# Written per run by the Kairoku daemon (§21). Not part of the diff.", ""];
  // The app's own origin, as `link.ts` handed it to this RUN — not this
  // daemon's config, which no module but app/link/config may read. Never a
  // literal either: one operator's agents must never dial another operator's
  // app. This is the agent's MCP endpoint, the same one `plugin/.mcp.json`
  // gives Claude; the daemon itself still dials out only from `app.ts`.
  const origin = run.env.KAIROKU_URL;
  if (origin) {
    lines.push(
      "[mcp_servers.kairoku]",
      `url = ${JSON.stringify(`${origin.replace(/\/+$/, "")}/api/mcp`)}`,
      'bearer_token_env_var = "KAIROKU_PAT"',
      // `approval_policy = "never"` auto-DENIES approval requests, and a Kairoku
      // MCP write raises one unless the server is pre-approved.
      'default_tools_approval_mode = "approve"',
      "",
    );
  }
  // §21 — the same CodeGraph server Claude gets from `mcpServers`, in the form
  // Codex's project layer takes. Nothing machine-wide: this file is written
  // fresh into the run's worktree and excluded from the diff.
  if (run.codegraph) lines.push(codegraphTomlTable(run.codegraph));
  return lines.join("\n");
}

/**
 * The same layer one, at Codex's write. `command` runs the script materialised
 * beside the rules, which reads the payload on stdin and answers with Codex's
 * blocking contract for a synchronous hook (exit 2, reason on stderr).
 */
export function codexHooksJson(rules: Rules): string {
  return (
    JSON.stringify(
      {
        description: "Kairoku: the repo's own .kairoku/rules, at the write.",
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [{ type: "command", command: `sh ${JSON.stringify(rules.scanScript)}`, timeout: 30 }],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Both files, fresh, plus the exclusion. Idempotent; never throws a run over. */
export function writeCodexFiles(run: RoleRun): void {
  try {
    const dir = join(run.cwd, CODEX_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), codexConfigToml(run));
    if (run.rules) writeFileSync(join(dir, "hooks.json"), codexHooksJson(run.rules));
    excludeFromGit(run.cwd, CODEX_FILES);
  } catch {
    // A worktree we cannot write is a run that is about to fail anyway, and it
    // fails on the agent's own error rather than on this.
  }
}

// ---------------------------------------------------------------- the stream
//
// Best effort by design. `codex exec --json` has changed its envelope more than
// once, so a line this mapper does not recognise is DROPPED rather than shipped
// raw: the curated channel is a readable log, and an unrecognised internal
// event is noise a person has to scroll past. The full stream is on disk.

const NOISE = /reasoning|token_count|delta|task_started|turn_/;

/**
 * One JSONL line → one curated event, and (§23.4) the OUTCOME of a command as a
 * `result` rather than a second `tool` line.
 *
 * `started` is the caller's map of call id → the ms the command began, which is
 * the only way a duration exists at all: the envelope the installed codex-cli
 * 0.153.0 emits carries no elapsed time, only a `status` and an `exit_code`.
 * A pair whose begin was never seen — a resumed session, a line the buffer
 * dropped — still reports its outcome and simply claims no duration.
 *
 * BOTH ENVELOPES ARE ACCEPTED. 0.153.0 wraps everything as
 * `{type:"item.started"|"item.completed", item:{type:"command_execution", …}}`;
 * older builds emit `{msg:{type:"exec_command_begin"|"exec_command_end", …}}`.
 * The daemon does not choose which codex an operator installed, and dropping
 * one of the two would silently empty a run's log.
 */
export function codexEvent(
  line: string,
  started: Map<string, number> = new Map(),
  now: () => number = Date.now,
): ProviderEvent | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const msg = (parsed.msg ?? parsed.item ?? parsed) as Record<string, unknown>;
  const type = typeof msg.type === "string" ? msg.type : "";
  if (type === "" || NOISE.test(type)) return undefined;

  if (type.includes("error")) {
    return { kind: "error", text: text(msg.message ?? msg.text ?? line) };
  }
  if (type.includes("command") || type.includes("exec") || type.includes("patch")) {
    const id = typeof msg.call_id === "string" ? msg.call_id : typeof msg.id === "string" ? msg.id : "";
    if (finished(type, msg)) {
      const began = started.get(id);
      started.delete(id);
      return {
        kind: "result",
        text: resultText(succeeded(msg), began === undefined ? null : now() - began, output(msg)),
      };
    }
    if (id !== "") started.set(id, now());
    const command = Array.isArray(msg.command) ? msg.command.join(" ") : text(msg.command ?? msg.text ?? "");
    return { kind: "tool", text: `${type}: ${command}`.slice(0, 240) };
  }
  if (type.includes("message")) {
    const body = text(msg.message ?? msg.text ?? "");
    return body === "" ? undefined : { kind: "text", text: body };
  }
  return undefined;
}

/** Has this command stopped? An exit code or a settled status says so; so does the old `_end`. */
function finished(type: string, msg: Record<string, unknown>): boolean {
  return (
    type.endsWith("_end") ||
    typeof msg.exit_code === "number" ||
    msg.status === "completed" ||
    msg.status === "failed"
  );
}

/** The exit code is the fact; the status word is the fallback for a step that has none. */
function succeeded(msg: Record<string, unknown>): boolean {
  if (typeof msg.exit_code === "number") return msg.exit_code === 0;
  if (typeof msg.status === "string") return msg.status !== "failed";
  return msg.success !== false;
}

/** Whatever the command printed, in the order the two envelopes offer it. */
function output(msg: Record<string, unknown>): string {
  for (const value of [msg.aggregated_output, msg.stdout, msg.stderr, msg.formatted_output]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

// ------------------------------------------------------------------ the report

/**
 * The last balanced `{…}` in a blob, so a report wrapped in prose or a fence is
 * still read. Strings are respected, so a brace inside one does not close the
 * object.
 */
export function lastJsonObject(text: string): unknown {
  for (let open = text.lastIndexOf("{"); open >= 0; open = text.lastIndexOf("{", open - 1)) {
    const block = balanced(text, open);
    if (!block) continue;
    try {
      return JSON.parse(block) as unknown;
    } catch {
      // Not it; keep walking back.
    }
  }
  return undefined;
}

function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

// ------------------------------------------------------------------- the models

export type Exec = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * `codex debug models` renders the whole catalog, and every entry embeds a
 * multi-kilobyte `instructions_template`. PROJECT the slugs; never carry the
 * catalog — it would go up the heartbeat every beat.
 */
export async function codexModels(exec: Exec = execArgv): Promise<string[]> {
  try {
    const result = await exec(["codex", "debug", "models"], process.cwd());
    if (result.code !== 0) return [];
    const models = (JSON.parse(result.stdout) as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => (m as { slug?: unknown }).slug)
      .filter((slug): slug is string => typeof slug === "string" && slug !== "");
  } catch {
    // No codex on this machine, or an envelope we do not know. Advertise
    // nothing: the composer greys out what no machine offers.
    return [];
  }
}

// -------------------------------------------------------------------- the launch

/** The one thing this provider needs from the process layer — a test seam. */
export interface CodexLaunchOptions {
  readonly command: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly stdoutPath: string;
  readonly timeoutMs: number;
  readonly onLine?: (line: string) => void;
  /** Where `-o` was pointed, when this run demanded a report. */
  readonly reportPath?: string;
}

export interface CodexHandle {
  readonly pid: number | undefined;
  interrupt(): void;
  readonly exited: Promise<{ code: number | null; summary: string }>;
}

export interface CodexDeps {
  readonly launch?: (options: CodexLaunchOptions) => CodexHandle;
  readonly exec?: Exec;
  readonly readReport?: (path: string) => string;
  readonly tempDir?: () => string;
}

const realLaunch = (options: CodexLaunchOptions): CodexHandle => {
  const handle = procLaunch({
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdoutPath: options.stdoutPath,
    timeoutMs: options.timeoutMs,
    ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
  });
  return {
    pid: handle.pid,
    interrupt: () => handle.cancel(),
    exited: handle.exited.then((result) => ({
      code: result.exitCode,
      summary:
        result.outcome === "exited"
          ? result.error
            ? `spawn-failed: ${result.error}`
            : `exit ${result.exitCode}`
          : result.outcome,
    })),
  };
};

export function codexProvider(deps: CodexDeps = {}): Provider {
  const doLaunch = deps.launch ?? realLaunch;
  const readReport = deps.readReport ?? ((path: string) => readFileSync(path, "utf8"));
  const tempDir = deps.tempDir ?? (() => mkdtempSync(join(tmpdir(), "kairoku-codex-")));

  return {
    name: "codex",
    models: () => codexModels(deps.exec),
    launch(run: RoleRun): LaunchedRun {
      // Fresh per run, before the process exists. Idempotent, so the second and
      // third role turn of the same member rewrite the same two files.
      writeCodexFiles(run);
      const queue: ProviderEvent[] = [];
      /** §23.4 — call id → when it began, so a completion can carry a duration. */
      const started = new Map<string, number>();
      let wake: (() => void) | undefined;
      let closed = false;
      const emit = (event: ProviderEvent | undefined) => {
        if (!event) return;
        queue.push(event);
        wake?.();
      };

      let paths: CodexPaths = {};
      let reportPath: string | undefined;
      if (run.schema) {
        const dir = tempDir();
        const schemaPath = join(dir, "schema.json");
        reportPath = join(dir, "report.json");
        writeFileSync(schemaPath, JSON.stringify(run.schema));
        paths = { schemaPath, outPath: reportPath };
      }

      const handle = doLaunch({
        command: codexArgv(run, paths),
        cwd: run.cwd,
        env: run.env,
        stdin: `${withRoleContract(run.role, run.prompt, run.codegraph && CODEGRAPH_NOTE)}\n`,
        stdoutPath: run.logPath,
        timeoutMs: run.timeoutMs,
        onLine: (line) => emit(codexEvent(line, started)),
        ...(reportPath === undefined ? {} : { reportPath }),
      });

      const exit = handle.exited.then((result) => {
        closed = true;
        wake?.();
        const report = reportPath === undefined ? undefined : readMaybe(readReport, reportPath);
        if (run.schema && report === undefined) {
          return {
            ok: false,
            summary: `${result.summary}, and no structured report was written — the run fails closed (§20.4)`,
          };
        }
        return {
          ok: result.code === 0,
          summary: result.summary,
          ...(report === undefined ? {} : { report }),
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
        interrupt: () => handle.interrupt(),
        exit,
      };
    },
  };
}

function readMaybe(read: (path: string) => string, path: string): unknown {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return lastJsonObject(raw);
  }
}
