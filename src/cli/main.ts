#!/usr/bin/env bun
/**
 * kairoku — the Kairoku CLI. Dev entry (`bun run src/cli/main.ts`) and the
 * `bun build --compile` entry. Subcommands arrive in Phase 2; this is the
 * dispatch skeleton with `version` so the binary and the formula have
 * something to assert.
 */

import { version } from "../../package.json";

const usage = `kairoku ${version}

  kairoku version   print the version
  kairoku help      this
`;

const [command = "help"] = process.argv.slice(2);

switch (command) {
  case "version":
    console.log(`kairoku ${version}`);
    break;
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(usage);
    break;
  default:
    process.stderr.write(`kairoku: unknown command ${JSON.stringify(command)}\n\n${usage}`);
    process.exit(2);
}
