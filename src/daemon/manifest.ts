/**
 * §20.11 — `kairoku.json`: how a repo says what a run of it needs.
 *
 * READ FROM THE COMMITTED BASE BRANCH, NEVER THE WORKTREE. The worktree is
 * where the implementer is editing; a manifest an agent rewrote thirty seconds
 * ago is not the repo's contract, and the commands in it are run by this daemon
 * with the run's own environment. `git show origin/<defaultBranch>:kairoku.json`
 * is therefore the only way this file is ever loaded.
 *
 * NON-STRICT ON PURPOSE. Unknown keys are ignored rather than refused: the app
 * repo's own manifest carries a `"$comment"` pointing at the ruling, and a
 * schema that rejected it would make documenting the file a build failure. What
 * IS strict is the type of every key we do read — and, in one place, its VALUE:
 * `intelligence` names a daemon capability, and a typo silently given nothing
 * would be indistinguishable from a capability that did not help (see below).
 * Either way the error names the JSON PATH — `env.test.ports[1]`, not "invalid
 * manifest" — because the reader is an operator looking at a run that failed on
 * a machine they cannot see.
 *
 * The validator is hand-written rather than Zod: this daemon has exactly one
 * runtime dependency (§20.2) and `constraints.test.ts` enforces it. The property
 * the ruling asks for is the path in the error, and that is what is built.
 */

import { run as execArgv } from "./worktree";

export const MANIFEST_FILE = "kairoku.json";

/**
 * §21 Q15 — the code intelligences a repo may opt into, and the whole list of
 * them. The value is REFUSED rather than ignored when it is not one of these,
 * which is the one place this reader is strict about a value and not just a
 * type: a repo that typed `codegrpah` and was silently given nothing would look
 * exactly like a repo the index did not help, and the Q4 measurement would read
 * a typo as a verdict.
 */
export const INTELLIGENCE = ["codegraph"] as const;
export type Intelligence = (typeof INTELLIGENCE)[number];

/** One environment profile: what to give a run, and what to stand up for it. */
export interface EnvProfile {
  /** Dotenv files from the checkout that seed the merge's lowest layer. */
  readonly files: string[];
  /** A compose file, relative to the repo root. Absent = no services. */
  readonly compose?: string;
  /** Names of ports to allocate per run; substituted into `inject`. */
  readonly ports: string[];
  /** Values injected at the top of the merge, with `${PORT}` substituted. */
  readonly inject: Record<string, string>;
  /** Commands run in the worktree, with the merged env, once the services are up. */
  readonly init: string[];
}

export interface Manifest {
  readonly setup: string[];
  readonly env: Record<string, EnvProfile>;
  readonly check: string[];
  /** Opt-in per repo. Empty is the default and means nothing changes. */
  readonly intelligence: Intelligence[];
  readonly test?: string;
  readonly concurrency: { readonly test: number };
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly error: string };

/** Every failure reads `kairoku.json: <path> <what was wrong>`. */
class Invalid extends Error {}
const bad = (path: string, why: string): never => {
  throw new Invalid(`${MANIFEST_FILE}: ${path} ${why}`);
};

function strings(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) bad(path, "must be an array of strings");
  return (value as unknown[]).map((entry, i) => {
    if (typeof entry !== "string") bad(`${path}[${i}]`, "must be a string");
    return entry as string;
  });
}

function text(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") bad(path, "must be a string");
  return value as string;
}

function object(value: unknown, path: string, why: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(path, why);
  return value as Record<string, unknown>;
}

/**
 * A compose file is a path this daemon hands to `docker compose -f` with the
 * worktree as cwd. It has to stay inside the repo — `../../` would let a branch
 * point the run at a file nobody reviewed, with the run's own secrets exported
 * into it.
 */
function inside(path: string, at: string): string {
  const normalised = path.replace(/\\/g, "/");
  if (normalised.startsWith("/") || normalised.split("/").includes("..")) {
    bad(at, "must stay inside the repo (no absolute path, no `..`)");
  }
  return path;
}

function profile(value: unknown, path: string): EnvProfile {
  const raw = object(value, path, "must be an object");
  const compose = text(raw.compose, `${path}.compose`);
  const inject: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object(raw.inject, `${path}.inject`, "must be an object"))) {
    if (typeof entry !== "string") bad(`${path}.inject.${key}`, "must be a string");
    inject[key] = entry as string;
  }
  return {
    files: strings(raw.files, `${path}.files`),
    ...(compose === undefined ? {} : { compose: inside(compose, `${path}.compose`) }),
    ports: strings(raw.ports, `${path}.ports`),
    inject,
    init: strings(raw.init, `${path}.init`),
  };
}

export function parseManifest(source: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: `${MANIFEST_FILE}: is not valid JSON` };
  }
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      bad("the manifest", "must be an object");
    }
    const top = raw as Record<string, unknown>;

    const env: Record<string, EnvProfile> = {};
    for (const [name, value] of Object.entries(object(top.env, "env", "must be an object of profiles"))) {
      env[name] = profile(value, `env.${name}`);
    }

    const concurrency = object(top.concurrency, "concurrency", "must be an object");
    let concurrentTests = 1;
    if (concurrency.test !== undefined) {
      const n = concurrency.test;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
        bad("concurrency.test", "must be a positive integer");
      }
      concurrentTests = n as number;
    }

    const intelligence = strings(top.intelligence, "intelligence").map((entry, i) => {
      if (!(INTELLIGENCE as readonly string[]).includes(entry)) {
        bad(`intelligence[${i}]`, `is not one of: ${INTELLIGENCE.join(", ")}`);
      }
      return entry as Intelligence;
    });

    const test = text(top.test, "test");
    return {
      ok: true,
      manifest: {
        setup: strings(top.setup, "setup"),
        env,
        check: strings(top.check, "check"),
        intelligence,
        ...(test === undefined ? {} : { test }),
        concurrency: { test: concurrentTests },
      },
    };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

/** The profile the claim asked for, or `undefined` — never a guessed default. */
export function profileOf(manifest: Manifest, name: string): EnvProfile | undefined {
  return Object.prototype.hasOwnProperty.call(manifest.env, name) ? manifest.env[name] : undefined;
}

/**
 * The manifest as the base branch has it. `undefined` means the repo has none,
 * which is not an error — it is §20.11's "no manifest → today's behaviour".
 */
export async function readManifest(
  repoPath: string,
  ref: string,
  exec = execArgv,
): Promise<ManifestResult | undefined> {
  let result;
  try {
    result = await exec(["git", "show", `${ref}:${MANIFEST_FILE}`], repoPath);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  return parseManifest(result.stdout);
}
