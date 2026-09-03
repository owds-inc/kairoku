/**
 * §21 — the repo's own code-shape rules, read from the BASE BRANCH.
 *
 * `.kairoku/rules/*.yml` in the target repo, in ast-grep's own rule format,
 * loaded with `git ls-tree` + `git show` against `origin/<defaultBranch>` for
 * exactly the reason `manifest.ts` loads `kairoku.json` that way: the worktree
 * is where the implementer is editing, and a rule an agent can delete in its
 * own PR is not a rule. A rule change takes effect after the merge, never
 * before it.
 *
 * THREE THINGS THIS MODULE REFUSES TO GUESS.
 *
 *   No `.kairoku/rules` on the base branch is NOT an error. It is §21's "the
 *   plugin ships no default rules and runs ast-grep only when that directory
 *   exists" — nothing materialises, nothing scans, and one line says so.
 *
 *   Rules on the base branch and no `ast-grep` on this machine FAILS THE RUN
 *   CLOSED, naming ast-grep (§21 Q25), the way a missing secret resolver does
 *   in `env.ts`. A repo that states a rule and a machine that cannot check it
 *   is a run that would report clean without having looked.
 *
 *   Output this daemon cannot parse is a FAILURE, never "no matches". `[]` from
 *   ast-grep is proof the scan ran; empty stdout from a non-zero exit is proof
 *   of nothing, and reading it as clean is how a broken scanner passes a
 *   violating diff.
 *
 * ast-grep is a BINARY, not an import: §20.2's one-runtime-dependency rule is
 * untouched and `constraints.test.ts` still holds. It is spawned through the
 * path `which` RESOLVED — which is rule 3's own lesson (CLI PR #7 defect 5),
 * and this repo dogfoods that rule.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run as execArgv, type CommandResult } from "./worktree";

/** Where a target repo states its rules. Relative to the repo root. */
export const RULES_PATH = ".kairoku/rules";

/** The exemplar file the roles are told to read before their first write (§21 Q6). */
export const PATTERNS_PATH = ".kairoku/patterns.md";

/** The one binary. Named in every failure so an operator knows what to install. */
export const AST_GREP = "ast-grep";

/** The scan script the Codex hook runs. Materialised beside the rules. */
export const SCAN_SCRIPT = "kairoku-rules-scan.sh";

/** Everything a scan needs, settled once per dispatch. */
export interface Rules {
  /** The materialised root: holds `sgconfig.yml` and `rules/`. */
  readonly dir: string;
  /** `<dir>/sgconfig.yml` — `scan -r` takes ONE file, a directory needs this. */
  readonly config: string;
  /** The RESOLVED ast-grep path, never the bare name. */
  readonly bin: string;
  /** The rule file names as the base branch has them, for the log line. */
  readonly ids: string[];
  /** `<dir>/kairoku-rules-scan.sh` — the Codex `PostToolUse` command. */
  readonly scanScript: string;
}

export type RulesResult = { readonly ok: true; readonly rules?: Rules } | { readonly ok: false; readonly error: string };

export interface RulesDeps {
  readonly exec?: (argv: string[], cwd: string) => Promise<CommandResult>;
  readonly which?: (bin: string) => string | null;
}

const realWhich = (bin: string): string | null => Bun.which(bin, { PATH: process.env.PATH ?? "" });

/**
 * The Codex hook's command, written per dispatch.
 *
 * SH, NOT JSON. The daemon-side callers below read `--json=compact` because
 * they need `[]` as positive proof the scan ran; a POSIX shell cannot parse
 * that, so this one uses `--report-style medium`, whose stdout carries the rule
 * id, `file:line:col`, the message AND the note — the same four facts — and is
 * empty exactly when nothing matched.
 *
 * Exit 2 with the reason on stderr is Codex's blocking contract for a
 * synchronous hook. Exit 1 marks the hook FAILED rather than blocking, which is
 * the honest answer when the scanner itself could not run: QA is the gate of
 * record and it fails closed on the same condition.
 */
function scanScript(bin: string, config: string): string {
  return [
    "#!/bin/sh",
    "# Written per dispatch by the Kairoku daemon (§21). Not part of the diff.",
    "set -u",
    'INPUT=$(cat 2>/dev/null || true)',
    `FILE=$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    '# No path in the payload, or a path that is gone: scan the worktree instead of',
    '# skipping. Silence here would be a hole in the layer.',
    '[ -n "$FILE" ] && [ -e "$FILE" ] || FILE=.',
    `OUT=$(${JSON.stringify(bin)} scan -c ${JSON.stringify(config)} --report-style medium --color never "$FILE" 2>/tmp/kairoku-rules-scan.err)`,
    "CODE=$?",
    'if [ -n "$OUT" ]; then',
    '  printf \'%s\\n\' "$OUT" >&2',
    "  exit 2",
    "fi",
    '[ "$CODE" -eq 0 ] || { cat /tmp/kairoku-rules-scan.err >&2; exit 1; }',
    "exit 0",
    "",
  ].join("\n");
}

/**
 * The rules as the base branch has them, written into the run's scratch dir.
 *
 * `dir` is per dispatch, so every member of a team is held to one materialised
 * copy even if someone pushes to the base branch mid-fan-out — the same
 * property `manifest.ts` gets from being read once.
 */
export async function materialiseRules(
  repoPath: string,
  ref: string,
  dir: string,
  deps: RulesDeps = {},
): Promise<RulesResult> {
  const exec = deps.exec ?? execArgv;
  const which = deps.which ?? realWhich;

  let listed: CommandResult;
  try {
    listed = await exec(["git", "ls-tree", "-r", "--name-only", ref, "--", RULES_PATH], repoPath);
  } catch {
    // No git, no ref, no checkout. Indistinguishable from "no rules", and both
    // mean the same thing here: nothing to enforce.
    return { ok: true };
  }
  if (listed.code !== 0) return { ok: true };

  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\.ya?ml$/i.test(line))
    .map((line) => basename(line));
  if (ids.length === 0) return { ok: true };

  const bin = which(AST_GREP);
  if (!bin) {
    return {
      ok: false,
      error:
        `this repo's base branch declares ${ids.length} rule(s) in ${RULES_PATH} and ${AST_GREP} is not installed ` +
        `on this machine, so they cannot be checked — \`kairoku setup --daemon\` installs it`,
    };
  }

  const rulesDir = join(dir, "rules");
  try {
    mkdirSync(rulesDir, { recursive: true });
    for (const id of ids) {
      const shown = await exec(["git", "show", `${ref}:${RULES_PATH}/${id}`], repoPath);
      if (shown.code !== 0) {
        return { ok: false, error: `${RULES_PATH}/${id} is on the base branch but could not be read` };
      }
      writeFileSync(join(rulesDir, id), shown.stdout);
    }
    // ast-grep's `-r` takes exactly one rule file; a DIRECTORY of them needs a
    // project config, so the daemon writes the smallest possible one.
    writeFileSync(join(dir, "sgconfig.yml"), "ruleDirs:\n  - rules\n");
    const scriptPath = join(dir, SCAN_SCRIPT);
    writeFileSync(scriptPath, scanScript(bin, join(dir, "sgconfig.yml")), { mode: 0o700 });
    return { ok: true, rules: { dir, config: join(dir, "sgconfig.yml"), bin, ids, scanScript: scriptPath } };
  } catch (err) {
    return { ok: false, error: `the repo's rules could not be materialised: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One violation, as a reader needs it: which rule, which line, and what for. */
export interface RuleMatch {
  readonly ruleId: string;
  readonly file: string;
  /** 1-based, as every editor and stack trace counts. ast-grep's json is 0-based. */
  readonly line: number;
  readonly message: string;
  /** The defect the rule exists for (§21 Q10: a rule cites the defect it caught). */
  readonly note?: string;
}

export type ScanResult =
  | { readonly ok: true; readonly matches: RuleMatch[] }
  | { readonly ok: false; readonly error: string };

/** ast-grep's `--json` element, narrowed to the five fields this daemon reads. */
interface RawMatch {
  file?: unknown;
  ruleId?: unknown;
  message?: unknown;
  note?: unknown;
  range?: { start?: { line?: unknown } };
}

export async function scanRules(
  rules: Rules,
  cwd: string,
  paths: string[],
  exec: (argv: string[], cwd: string) => Promise<CommandResult> = execArgv,
): Promise<ScanResult> {
  let result: CommandResult;
  try {
    // The RESOLVED path, not the bare name — `which` and `spawn` answering from
    // two different PATHs is the defect rule 3 exists for.
    result = await exec([rules.bin, "scan", "-c", rules.config, "--json=compact", ...paths], cwd);
  } catch (err) {
    return { ok: false, error: `${AST_GREP} could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The exit code is NOT the signal: ast-grep exits non-zero precisely when it
  // found something. `[]` on stdout is the proof the scan ran.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return {
      ok: false,
      error: `${AST_GREP} printed no result this daemon can read: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `${AST_GREP} answered with something that is not a match list` };
  }
  return {
    ok: true,
    matches: (parsed as RawMatch[]).map((raw) => ({
      ruleId: typeof raw.ruleId === "string" ? raw.ruleId : "(unnamed rule)",
      file: typeof raw.file === "string" ? raw.file : "(unknown file)",
      line: Number(raw.range?.start?.line ?? 0) + 1,
      message: typeof raw.message === "string" ? raw.message : "",
      ...(typeof raw.note === "string" && raw.note !== "" ? { note: raw.note } : {}),
    })),
  };
}

/** What the agent is shown, at the write and in the fix loop. Ids and file:line. */
export function formatMatches(matches: readonly RuleMatch[]): string {
  return matches
    .map((m) => `${m.ruleId} — ${m.file}:${m.line} — ${m.message}${m.note ? `\n  ${m.note}` : ""}`)
    .join("\n");
}
