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

/** Ordered: the most specific line shapes first, bun's loose one last. */
const PARSERS: Parser[] = [vitest, jest, goTest, bun];

export function parseSummary(text: string): SuiteCounts | undefined {
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
  readonly source: "kairoku.json" | "package.json" | "none";
}

/**
 * The manifest first, package.json second, nothing third.
 *
 * O-4 owns `kairoku.json` properly (environments, compose, ports). Reading the
 * three fields QA needs here costs four lines and means a repo that already has
 * a manifest is not run with the wrong commands for one lane.
 */
export function qaPlan(worktree: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): QaPlan {
  const manifest = json(read, join(worktree, "kairoku.json"));
  if (manifest) {
    const check = Array.isArray(manifest.check) ? manifest.check.filter((c): c is string => typeof c === "string") : [];
    const test = typeof manifest.test === "string" ? manifest.test : undefined;
    const concurrency = (manifest.concurrency as { test?: unknown } | undefined)?.test;
    return {
      check,
      ...(test === undefined ? {} : { test }),
      concurrency: typeof concurrency === "number" && concurrency > 0 ? concurrency : 1,
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
      source: "package.json",
    };
  }
  // No test script is not "run something else": it is counts unavailable, which
  // `runQa` fails closed on (invariant 7).
  return { check: [], concurrency: 1, source: "none" };
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
// semaphore per limit, held for the duration of the suite.
//
// ponytail: in-process, so it bounds THIS daemon's suites. Two daemons sharing
// a machine would each get the limit; make it a lock directory under
// ~/.kairoku if that ever happens.

const gates = new Map<number, { active: number; waiting: Array<() => void> }>();

async function withGate<T>(limit: number, work: () => Promise<T>): Promise<T> {
  const gate = gates.get(limit) ?? { active: 0, waiting: [] };
  gates.set(limit, gate);
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
  readonly exec?: (command: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The last `lines` lines — what a failing run attaches as its defect. */
export function tail(text: string, lines = 100): string {
  return text.split("\n").slice(-lines).join("\n");
}

const shell = (command: string, cwd: string) => execArgv(["sh", "-c", command], cwd);

export async function runQa(worktree: string, deps: QaDeps): Promise<QaResult> {
  const { plan } = deps;
  const exec = deps.exec ?? shell;

  for (const command of plan.check) {
    const result = await exec(command, worktree);
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

  const result = await withGate(plan.concurrency, () => exec(plan.test!, worktree));
  const output = `${result.stdout}${result.stderr}`;
  const counts = parseSummary(output);

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
