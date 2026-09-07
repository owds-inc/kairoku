/**
 * §20.4 / grill Q2 — QA IS A DETERMINISTIC DAEMON STEP, NOT AN AGENT.
 *
 * It runs the repo's own commands, parses the runner's own summary, and hands
 * back four numbers and, on failure, the tail that says why. No model is asked
 * whether the suite passed, which is the whole point: invariant 7 ("no count,
 * no claim") is only worth anything if the counts come from the runner rather
 * than from something that can be persuaded.
 *
 * IT FAILS CLOSED in three places, and each of them is a place a plausible
 * implementation would have passed: a runner nobody here can parse, a repo with
 * no test command at all, and a non-zero `errors` beside zero `fail`. All three
 * mean "this run may not cite a suite", which is exactly a QA failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteCounts } from "./app";
import type { Manifest } from "./manifest";
import { formatMatches, type ScanResult } from "./rules";
import { run as execArgv } from "./worktree";

// ------------------------------------------------------------------- parsers
//
// One per runner we know how to read. `undefined` from all of them is the
// honest answer "counts unavailable", never a zeroed record — bun prints its
// errors line only when the count is non-zero, so "absent" and "zero" are
// exactly the two states a reader must not confuse.

type Parser = (text: string) => SuiteCounts | undefined;

/** bun: one `N word` per line, `errors` omitted entirely when zero. */
const bun: Parser = (text) => {
  const found: Record<string, number> = {};
  for (const [, n, word] of text.matchAll(/^\s*(\d+)\s+(pass|fail|skip|todo|error|errors)\b/gm)) {
    const key = word === "errors" ? "error" : word!;
    found[key] = (found[key] ?? 0) + Number(n);
  }
  if (found.pass === undefined && found.fail === undefined) return undefined;
  return { pass: found.pass ?? 0, fail: found.fail ?? 0, skip: found.skip ?? 0, errors: found.error ?? 0 };
};

/** vitest: `Tests  3 failed | 10 passed | 2 skipped (15)`. */
const vitest: Parser = (text) => {
  const line = text.match(/^\s*Tests\s+(.+)$/m)?.[1];
  if (!line) return undefined;
  const read = (word: string) => Number(line.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0);
  return { pass: read("passed"), fail: read("failed"), skip: read("skipped"), errors: 0 };
};

/** jest: `Tests:  1 failed, 2 skipped, 10 passed, 13 total`. */
const jest: Parser = (text) => {
  const line = text.match(/^\s*Tests:\s+(.+)$/m)?.[1];
  if (!line) return undefined;
  const read = (word: string) => Number(line.match(new RegExp(`(\\d+)\\s+${word}`))?.[1] ?? 0);
  return { pass: read("passed"), fail: read("failed"), skip: read("skipped"), errors: 0 };
};

/** go test -v: one `--- PASS/FAIL/SKIP:` line per test. */
const goTest: Parser = (text) => {
  const count = (word: string) => [...text.matchAll(new RegExp(`^\\s*--- ${word}:`, "gm"))].length;
  const pass = count("PASS");
  const fail = count("FAIL");
  const skip = count("SKIP");
  return pass + fail + skip === 0 ? undefined : { pass, fail, skip, errors: 0 };
};

/**
 * cargo nextest: one `Summary [<time>] N tests run: …` line, and it is last.
 *
 * Reached ONLY through `parseSummary`'s command check, never by sniffing — see
 * the comment there. `(N flaky, M leaky)` is read past and moves no count: a
 * flake that did not recover is reported as `failed`, kairokud sets
 * `retries = 1` so a flake is a routine event, and `runQa` catches a non-zero
 * exit on its own. nextest has no error counter, so `errors` is always 0.
 *
 * The `, N skipped` clause is optional here because no recorded run of this
 * workspace has had zero skipped, so whether nextest omits the clause at zero
 * is untested. Defaulting to 0 is right either way.
 */
const nextest: Parser = (text) => {
  const found = [...text.matchAll(/^\s*Summary \[[^\]]*\]\s+\d+\s+tests? run:\s*(.+)$/gm)];
  const tail = found.length === 0 ? undefined : found[found.length - 1]![1];
  if (tail === undefined) return undefined;
  const read = (word: string): number | undefined => {
    const hit = tail.match(new RegExp(`(\\d+) ${word}`));
    return hit ? Number(hit[1]) : undefined;
  };
  const pass = read("passed");
  // A summary line with no `passed` clause is a shape this parser has not seen.
  // Counts unavailable is the honest answer; a guessed zero is not.
  if (pass === undefined) return undefined;
  return { pass, fail: read("failed") ?? 0, skip: read("skipped") ?? 0, errors: 0 };
};

/** `cargo nextest …`, with an optional `+toolchain` and any leading env prefix. */
const NEXTEST_COMMAND = /(^|[\s;&|])cargo\s+(\+\S+\s+)?nextest\b/;

/** Ordered: the most specific line shapes first, bun's loose one last. */
const PARSERS: Parser[] = [vitest, jest, goTest, bun];

export function parseSummary(text: string, command?: string): SuiteCounts | undefined {
  // Selection is by the COMMAND the daemon just ran, never by sniffing the text.
  // A failing Rust test's captured stdout is echoed into this output and can
  // carry another runner's summary shape, so an ordered fallback could read a
  // red suite as a clean one. And it FAILS CLOSED: a nextest run with no
  // Summary line was cancelled or died, so it does not fall through to the
  // other four.
  if (command !== undefined && NEXTEST_COMMAND.test(command)) return nextest(text);
  for (const parser of PARSERS) {
    const counts = parser(text);
    if (counts) return counts;
  }
  return undefined;
}

// ---------------------------------------------------------------- what to run

export interface QaPlan {
  /** Commands that must all exit 0 before the suite is worth running. */
  readonly check: string[];
  readonly test?: string;
  /** How many suites this repo tolerates at once on one machine. */
  readonly concurrency: number;
  /** What the concurrency gate queues on: the repo, never the number itself. */
  readonly key: string;
  readonly source: "kairoku.json" | "package.json" | "none";
}

export interface QaPlanOptions {
  /**
   * The manifest as the BASE BRANCH has it (O-4). It is passed in rather than
   * read from the worktree: the worktree is where the implementer is editing,
   * and a gate whose commands the agent under review can rewrite is not a gate.
   */
  readonly manifest?: Manifest;
  /** `owner/name`, when the daemon knows it. Falls back to the worktree path. */
  readonly key?: string;
  readonly read?: (path: string) => string;
}

/**
 * The manifest first, package.json second, nothing third.
 */
export function qaPlan(worktree: string, options: QaPlanOptions = {}): QaPlan {
  const read = options.read ?? ((p: string) => readFileSync(p, "utf8"));
  const key = options.key ?? worktree;
  const manifest = options.manifest;
  if (manifest && (manifest.check.length > 0 || manifest.test !== undefined)) {
    return {
      check: manifest.check,
      ...(manifest.test === undefined ? {} : { test: manifest.test }),
      concurrency: manifest.concurrency.test,
      key,
      source: "kairoku.json",
    };
  }

  const pkg = json(read, join(worktree, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  if (pkg && typeof scripts.test === "string") {
    const run = packageManager(worktree, read);
    return {
      check: ["lint", "build"].filter((name) => typeof scripts[name] === "string").map((name) => `${run} ${name}`),
      // THE PACKAGE'S OWN SCRIPT, never `bun test` in its place. A repo whose
      // `test` is `vitest run` or `go test ./...` would otherwise have bun's
      // runner walk the same files and print "0 pass · 0 fail" — a summary
      // `parseSummary` reads as a clean zero-count suite, so the member would
      // report done citing counts no suite of this repo ever produced.
      test: `${run} test`,
      concurrency: 1,
      key,
      source: "package.json",
    };
  }
  // No test script is not "run something else": it is counts unavailable, which
  // `runQa` fails closed on (invariant 7).
  return { check: [], concurrency: 1, key, source: "none" };
}

/** The lockfile names the installer, and the installer is what can run a script. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["bun.lock", "bun run"],
  ["bun.lockb", "bun run"],
  ["pnpm-lock.yaml", "pnpm run"],
  // yarn takes no `run` for a script: `yarn test`.
  ["yarn.lock", "yarn"],
];

function packageManager(worktree: string, read: (path: string) => string): string {
  for (const [file, run] of LOCKFILES) {
    try {
      read(join(worktree, file));
      return run;
    } catch {
      // Not this one.
    }
  }
  // npm is the fallback because it is the one every Node install already has.
  return "npm run";
}

function json(read: (path: string) => string, path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(read(path)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------- the gate
//
// §20.11's "the suite lock becomes a per-repo concurrency setting". One
// semaphore PER REPO, held for the duration of the suite.
//
// Keyed by the repo rather than by the limit: two repos that both said `2` are
// two queues. Keyed by the number, a daemon holding two checkouts would
// serialise them against each other and give each repo half of what it asked
// for, for no reason either repo could see.
//
// ponytail: in-process, so it bounds THIS daemon's suites. Two daemons sharing
// a machine would each get the limit; make it a lock directory under
// ~/.kairoku if that ever happens.

const gates = new Map<string, { active: number; waiting: Array<() => void> }>();

async function withGate<T>(key: string, limit: number, work: () => Promise<T>): Promise<T> {
  const gate = gates.get(key) ?? { active: 0, waiting: [] };
  gates.set(key, gate);
  if (gate.active >= limit) await new Promise<void>((release) => gate.waiting.push(release));
  gate.active++;
  try {
    return await work();
  } finally {
    gate.active--;
    gate.waiting.shift()?.();
  }
}

// --------------------------------------------------------------------- the step

export interface QaResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly counts?: SuiteCounts;
  /** What the implementer's fix loop is given, verbatim. */
  readonly defect?: string;
}

export interface QaDeps {
  readonly plan: QaPlan;
  /**
   * The run's merged environment (§20.11). Absent means the daemon's own, which
   * is only ever right for a repo with no profile — a suite that inherited the
   * machine's `DATABASE_URL` would run green against the developer's own
   * database while the run's compose project sat there untouched.
   */
  readonly env?: Record<string, string>;
  readonly exec?: (
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * §21 layer two — the repo's own rules over the WHOLE worktree, run before
   * anything else. A thunk rather than the rules themselves so this module
   * never learns what ast-grep is: `dispatch.ts` binds it when, and only when,
   * the base branch declared rules. Absent = the repo declares none.
   *
   * No manifest entry asks for this. §21's lead ruling makes it automatic
   * whenever `.kairoku/rules/` is on the base branch, so a repo cannot opt its
   * own gate out in the same file the gate reads.
   */
  readonly scan?: () => Promise<ScanResult>;
}

/** The last `lines` lines — what a failing run attaches as its defect. */
export function tail(text: string, lines = 100): string {
  return text.split("\n").slice(-lines).join("\n");
}

const shell = (command: string, cwd: string, env?: Record<string, string>) =>
  execArgv(["sh", "-c", command], cwd, env);

export async function runQa(worktree: string, deps: QaDeps): Promise<QaResult> {
  const { plan, env } = deps;
  const exec = deps.exec ?? shell;

  // FIRST, before the repo's own commands. A violation is a defect the fix loop
  // can act on in seconds; making the agent wait out a full suite to hear it is
  // the same information an hour later.
  if (deps.scan) {
    const scan = await deps.scan();
    if (!scan.ok) {
      // Fail closed, for the reason the counts do: a step that cannot look may
      // not report that it looked and found nothing.
      return {
        ok: false,
        summary: "QA: the repo's rules could not be checked",
        defect: scan.error,
      };
    }
    if (scan.matches.length > 0) {
      const n = scan.matches.length;
      return {
        ok: false,
        summary: `QA: ${n} violation(s) of this repo's own rules (${[...new Set(scan.matches.map((m) => m.ruleId))].join(", ")})`,
        defect: formatMatches(scan.matches),
      };
    }
  }

  for (const command of plan.check) {
    const result = await exec(command, worktree, env);
    if (result.code !== 0) {
      return {
        ok: false,
        summary: `QA: \`${command}\` exited ${result.code}`,
        defect: tail(`${result.stdout}${result.stderr}`),
      };
    }
  }

  if (!plan.test) {
    return {
      ok: false,
      summary: "QA: no test command in this repo, so no suite can be cited (invariant 7)",
      defect: `No \`test\` in ${plan.source === "none" ? "kairoku.json or package.json" : plan.source}.`,
    };
  }

  const result = await withGate(plan.key, plan.concurrency, () => exec(plan.test!, worktree, env));
  const output = `${result.stdout}${result.stderr}`;
  const counts = parseSummary(output, plan.test);

  if (!counts) {
    return {
      ok: false,
      summary: `QA: counts unavailable — \`${plan.test}\` printed no summary this daemon can read`,
      defect: tail(output),
    };
  }
  if (counts.fail > 0 || counts.errors > 0 || result.code !== 0) {
    return {
      ok: false,
      summary: `QA: ${counts.pass} pass · ${counts.fail} fail · ${counts.skip} skip · ${counts.errors} errors`,
      counts,
      defect: tail(output),
    };
  }
  return {
    ok: true,
    summary: `QA: ${counts.pass} pass · ${counts.fail} fail · ${counts.skip} skip · ${counts.errors} errors`,
    counts,
  };
}
