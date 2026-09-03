/**
 * §20.11 — the VALUES a run is given, merged low → high:
 *
 *   1. the checkout's `.env*` — the profile's own `files[]`, already copied into
 *      the worktree by `copyEnvFiles`;
 *   2. this daemon's env store, `~/.kairoku/env/<owner>/<repo>/<profile>.env`,
 *      mode 0600, written by `kairoku env set|import|rm`;
 *   3. the project's secrets, delivered in the claim — a value, or a `{ref}` this
 *      machine resolves itself against its own vault CLI;
 *   4. per-run: the run's credential, its ids, the ports allocated for it, and
 *      the profile's `inject{}` with `${PORT}` substituted.
 *
 * TWO THINGS NEVER HAPPEN HERE, and both are the point of the layer:
 *
 * A DELIVERED SECRET IS NEVER WRITTEN DOWN. Layer 3 exists in this process's
 * memory and in the environment of the processes it launches. Nothing under
 * `~/.kairoku` and nothing in the worktree receives it, because a worktree is a
 * git checkout an agent can commit and a `~/.kairoku` file outlives the run.
 *
 * A FAILURE NEVER CARRIES A VALUE, OR A LOCATOR. When a reference cannot be
 * resolved the run fails naming the KEY — not the value, and not the `op://…`
 * that names the vault, the item and the field. Failure text reaches the app's
 * run log, and a run log is read by everyone who can see the project.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kairokuHome, parseEnvFile } from "./config";
import { run as execArgv, type CommandResult } from "./worktree";

// -------------------------------------------------------------- substitution

/**
 * `${NAME}` → the allocated value. A name nobody allocated is LEFT IN PLACE:
 * a blanked `${PG_PORT}` yields `postgres://127.0.0.1:/main`, which looks like a
 * URL and connects to nothing, and the run then fails somewhere far away from
 * the manifest line that caused it.
 */
export function substitute(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

// ---------------------------------------------------------------- the merge

export interface MergeLayers {
  readonly checkout: Record<string, string>;
  readonly store: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly perRun: Record<string, string>;
}

/** Low → high, in the order §20.11 names them. Nothing else decides precedence. */
export function mergeEnv(layers: MergeLayers): Record<string, string> {
  return { ...layers.checkout, ...layers.store, ...layers.secrets, ...layers.perRun };
}

// ----------------------------------------------------------- layer 1: files

/**
 * The profile's `files[]`, read from the worktree in the order the manifest
 * lists them — later wins, which is the convention every dotenv loader uses.
 * An absent file is skipped: a repo naming `.env.local` is naming the file a
 * developer may have, not one that must exist.
 */
export function readCheckoutEnv(worktree: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of files) {
    try {
      Object.assign(out, parseEnvFile(readFileSync(join(worktree, name), "utf8")));
    } catch {
      // Not there, or not readable. Neither is a reason to fail a run.
    }
  }
  return out;
}

// ----------------------------------------------------------- layer 2: the store

/** One path segment of a store path may not climb, and may not be a separator. */
function segment(value: string, what: string): string {
  if (value === "" || value === "." || value === ".." || value.includes("\\") || /[\0]/.test(value)) {
    throw new Error(`${what} must not contain a path segment like ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `~/.kairoku/env/<owner>/<repo>/<profile>.env`.
 *
 * The repo's own `owner/name` is the key, so one daemon holding two checkouts
 * cannot serve the second one's values to the first. Every segment is checked:
 * a repo name is a string that arrived over the wire.
 */
export function envStorePath(home: string, repoFullName: string, profile: string): string {
  const parts = repoFullName.split("/").filter((p) => p !== "");
  if (parts.length < 2) throw new Error(`"${repoFullName}" must not contain fewer than two path segments`);
  for (const part of parts) segment(part, "a repo name");
  segment(profile, "a profile name");
  if (profile.includes("/")) throw new Error("a profile name must not contain a path separator");
  return join(kairokuHome(home), "env", ...parts, `${profile}.env`);
}

export function readEnvStore(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Replaces the file wholesale, mode 0600. The directory is created 0700. */
export function writeEnvStore(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(path, body ? `${body}\n` : "", { mode: 0o600 });
  // `mode` on writeFileSync is ignored for a file that already exists.
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch {
    // A store we cannot stat is one the caller will fail to read next.
  }
}

// --------------------------------------------------------- layer 3: secrets

/** As the app delivers it: a value, or a pointer this machine resolves. */
export type DeliveredSecret = string | { readonly ref: string };

export interface ResolverDeps {
  which(bin: string): string | null;
  exec(argv: string[], cwd: string): Promise<CommandResult>;
}

const realResolvers: ResolverDeps = {
  which: (bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }),
  exec: (argv, cwd) => execArgv(argv, cwd),
};

/**
 * The two resolvers §20.11 names. Each is `{ match, bin, label, argv }` so that
 * adding a third is a table entry rather than another branch — and so that the
 * failure message can say WHICH tool is missing without the caller knowing any
 * of them.
 */
const RESOLVERS = [
  {
    match: (ref: string) => ref.startsWith("op://"),
    bin: "op",
    label: "the 1Password CLI (op)",
    argv: (bin: string, ref: string) => [bin, "read", "--no-newline", ref],
  },
  {
    match: (ref: string) => ref.startsWith("arn:aws:secretsmanager:"),
    bin: "aws",
    label: "the AWS CLI (aws)",
    argv: (bin: string, ref: string) => [
      bin,
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      ref,
      "--query",
      "SecretString",
      "--output",
      "text",
    ],
  },
] as const;

export type SecretsResult =
  | { readonly ok: true; readonly values: Record<string, string> }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve what the claim delivered. Every failure names the key and stops the
 * run: half an environment is worse than none, because the run gets far enough
 * to do something with the wrong database.
 */
export async function resolveSecrets(
  secrets: Record<string, DeliveredSecret>,
  deps: ResolverDeps = realResolvers,
): Promise<SecretsResult> {
  const values: Record<string, string> = {};
  for (const [key, delivered] of Object.entries(secrets)) {
    if (typeof delivered === "string") {
      values[key] = delivered;
      continue;
    }
    const ref = delivered?.ref;
    if (typeof ref !== "string" || ref === "") {
      return { ok: false, error: `${key}: the app delivered a reference this daemon cannot read` };
    }
    const resolver = RESOLVERS.find((r) => r.match(ref));
    if (!resolver) {
      return {
        ok: false,
        error: `${key}: its reference is in a scheme this daemon has no resolver for (op:// and AWS Secrets Manager ARNs are supported)`,
      };
    }
    const bin = deps.which(resolver.bin);
    if (!bin) {
      return { ok: false, error: `${key}: ${resolver.label} is not installed on this machine, so its reference cannot be resolved` };
    }
    // cwd is the daemon's own: a resolver reads a vault, never the repo.
    const result = await deps.exec(resolver.argv(bin, ref), process.cwd()).catch(() => undefined);
    if (!result || result.code !== 0) {
      // NOT the stderr. A vault CLI routinely echoes the locator it failed on,
      // and some echo the value it did read before failing on the next one.
      return { ok: false, error: `${key}: ${resolver.label} could not resolve its reference` };
    }
    values[key] = result.stdout.replace(/\n$/, "");
  }
  return { ok: true, values };
}

/** Which resolvers this machine has, for `kairoku doctor`. */
export function availableResolvers(which: (bin: string) => string | null): string[] {
  return RESOLVERS.filter((r) => which(r.bin) !== null).map((r) => r.bin);
}
