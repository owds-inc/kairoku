/**
 * `kairoku env` — layer 2 of §20.11: the values THIS MACHINE holds for a repo
 * and a profile, above the checkout's own `.env*` and below what the app
 * delivers.
 *
 * ONE RULE ABOVE ALL THE OTHERS: `list` prints NAMES. A store command that
 * echoes a value puts it in a terminal, in a scrollback, in a screen share and,
 * sooner or later, in a pasted issue. The file is 0600 and readable with `cat`
 * by whoever owns it; a CLI that prints it is a CLI that leaks it to everyone
 * standing behind them.
 *
 * The repo is derived from the configured checkout's own origin rather than
 * asked for, and a checkout whose origin cannot be read REFUSES rather than
 * guessing: writing to the wrong repo's store would hand one project's values
 * to another project's agents.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { kairokuHome, parseEnvFile } from "../daemon/config";
import { envStorePath, formatEnvStore } from "../daemon/env";
import { parseRepoFullName } from "../daemon/worktree";
import type { Io } from "./io";

export const usage = `usage: kairoku env <set|import|list|rm> [...] [--repo <owner/name>] [--profile <name>]

  The values this machine holds for a repo's runs — above the checkout's own
  .env* files, below the secrets the app delivers. Written 0600 under
  ~/.kairoku/env/<owner>/<repo>/<profile>.env.

  kairoku env set KEY=value [KEY=value ...]   add or replace values
  kairoku env import <file>                   merge a dotenv file in
  kairoku env list                            the NAMES held here (never the values)
  kairoku env rm KEY [KEY ...]                remove values

  --repo <owner/name>   default: the origin of the checkout in config.json
  --profile <name>      default: test`;

export const DEFAULT_PROFILE = "test";

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      profile: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** The `owner/name` of the configured checkout, asked of git the way the daemon does. */
async function repoOf(io: Io): Promise<string | undefined> {
  let repoPath: string;
  try {
    const config = JSON.parse(io.readFile(join(kairokuHome(io.home), "config.json")) ?? "{}") as {
      repoPath?: unknown;
    };
    repoPath = typeof config.repoPath === "string" ? config.repoPath : join(io.home, "work", "kairoku");
  } catch {
    return undefined;
  }
  const result = await io.shell(["git", "-C", repoPath, "remote", "get-url", "origin"]);
  return result.code === 0 ? parseRepoFullName(result.stdout) : undefined;
}

export async function run(args: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${usage}`);
    return 2;
  }
  if (parsed.values.help) {
    io.out(usage);
    return 0;
  }

  const [command, ...rest] = parsed.positionals;
  if (!command || !["set", "import", "list", "rm"].includes(command)) {
    io.err(`kairoku env: ${command ? `unknown subcommand ${JSON.stringify(command)}` : "no subcommand"}\n\n${usage}`);
    return 2;
  }

  const repo = parsed.values.repo ?? (await repoOf(io));
  if (!repo) {
    io.err(
      "kairoku env: cannot tell which repo this machine holds — the checkout in config.json has no readable origin.\n" +
        "  Name it: kairoku env " + command + " ... --repo <owner/name>",
    );
    return 1;
  }

  const profile = parsed.values.profile ?? DEFAULT_PROFILE;
  let path: string;
  try {
    path = envStorePath(join(kairokuHome(io.home), "env"), repo, profile);
  } catch (e) {
    io.err(`kairoku env: ${(e as Error).message}`);
    return 2;
  }

  const values = parseEnvFile(io.readFile(path) ?? "");
  const save = () => io.writeFile(path, formatEnvStore(values), 0o600);
  const where = `${repo} · ${profile}`;

  switch (command) {
    case "list": {
      const names = Object.keys(values).sort();
      io.out(`${where} — ${path}`);
      // The names, one per line. Never a value, not even a masked one: a masked
      // value still says how long it is and whether it changed.
      io.out(names.length ? names.map((name) => `  ${name}`).join("\n") : "  (no values held here)");
      return 0;
    }

    case "set": {
      if (rest.length === 0) {
        io.err(`kairoku env set: nothing to set\n\n${usage}`);
        return 2;
      }
      const names: string[] = [];
      for (const pair of rest) {
        // Only the FIRST `=` splits: a DSN, a URL and a base64 value all carry
        // more, and a second split would silently truncate every one of them.
        const at = pair.indexOf("=");
        if (at <= 0) {
          io.err(`kairoku env set: ${JSON.stringify(pair)} is not KEY=value\n\n${usage}`);
          return 2;
        }
        const key = pair.slice(0, at).trim();
        values[key] = pair.slice(at + 1);
        names.push(key);
      }
      save();
      io.out(`${where} — set ${names.join(", ")}`);
      return 0;
    }

    case "rm": {
      if (rest.length === 0) {
        io.err(`kairoku env rm: nothing to remove\n\n${usage}`);
        return 2;
      }
      const gone: string[] = [];
      const absent: string[] = [];
      for (const key of rest) {
        if (key in values) {
          delete values[key];
          gone.push(key);
        } else {
          absent.push(key);
        }
      }
      save();
      if (gone.length) io.out(`${where} — removed ${gone.join(", ")}`);
      // Said plainly rather than treated as a failure: `rm` of something absent
      // has left the store in exactly the state that was asked for.
      if (absent.length) io.out(`${where} — not held here: ${absent.join(", ")}`);
      return 0;
    }

    case "import": {
      const file = rest[0];
      if (!file) {
        io.err(`kairoku env import: no file\n\n${usage}`);
        return 2;
      }
      const text = io.readFile(file);
      if (text === null) {
        io.err(`kairoku env import: cannot read ${file}`);
        return 1;
      }
      const incoming = parseEnvFile(text);
      Object.assign(values, incoming);
      save();
      // The COUNT, never the names' values — and the names are already in the
      // file the operator just pointed at.
      io.out(`${where} — imported ${Object.keys(incoming).length} value(s) from ${file}`);
      return 0;
    }
  }
  return 2;
}
