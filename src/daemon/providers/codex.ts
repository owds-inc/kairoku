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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch as procLaunch } from "../proc";
import { withRoleContract } from "../roles";
import type { RoleName } from "../policy";
import { run as execArgv } from "../worktree";
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

export function codexArgv(run: RoleRun, paths: CodexPaths): string[] {
  const argv = [
    "codex",
    "exec",
    "--json",
    "-s",
    SANDBOX[run.role],
    "-c",
    'approval_policy="never"',
    "-C",
    run.cwd,
  ];
  if (run.model) argv.push("-m", run.model);
  if (run.schema && paths.schemaPath && paths.outPath) {
    argv.push("--output-schema", paths.schemaPath, "-o", paths.outPath);
  }
  // The prompt is NOT a positional argument: codex reads it from stdin when
  // none is given, which keeps it out of `ps` and stops a prompt beginning with
  // `-` being read as a flag.
  return argv;
}

// ---------------------------------------------------------------- the stream
//
// Best effort by design. `codex exec --json` has changed its envelope more than
// once, so a line this mapper does not recognise is DROPPED rather than shipped
// raw: the curated channel is a readable log, and an unrecognised internal
// event is noise a person has to scroll past. The full stream is on disk.

const NOISE = /reasoning|token_count|delta|task_started|turn_/;

export function codexEvent(line: string): ProviderEvent | undefined {
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
    const command = Array.isArray(msg.command) ? msg.command.join(" ") : text(msg.command ?? msg.text ?? "");
    return { kind: "tool", text: `${type}: ${command}`.slice(0, 240) };
  }
  if (type.includes("message")) {
    const body = text(msg.message ?? msg.text ?? "");
    return body === "" ? undefined : { kind: "text", text: body };
  }
  return undefined;
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
      const queue: ProviderEvent[] = [];
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
        stdin: `${withRoleContract(run.role, run.prompt)}\n`,
        stdoutPath: run.logPath,
        timeoutMs: run.timeoutMs,
        onLine: (line) => emit(codexEvent(line)),
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
