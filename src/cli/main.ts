#!/usr/bin/env bun
/**
 * kairoku — the Kairoku CLI. Dev entry (`bun run src/cli/main.ts`) and the
 * `bun build --compile` entry. The first argument picks the command; each
 * command parses the rest with node:util parseArgs and returns an exit code.
 */

import { version } from "../../package.json";
import { io, type Io } from "./io";
import * as doctor from "./doctor";
import * as plugin from "./plugin";
import * as setup from "./setup";
import * as update from "./update";

export const usage = `kairoku ${version} — the Kairoku CLI

  kairoku setup [--plugin] [--daemon] [--all] [--yes]
                                   set up the Claude Code plugin and/or the daemon;
                                   a wizard without flags
  kairoku doctor                   verify this machine, change nothing; nonzero on FAIL
  kairoku plugin install|update|status
                                   the Claude Code plugin, through the claude CLI
  kairoku update                   replace this binary with the latest release
  kairoku version
  kairoku help`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [command = "help", ...rest] = argv;
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      io.out(`kairoku ${version}`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      io.out(usage);
      return 0;
    case "plugin":
      return plugin.run(rest, io);
    case "doctor":
      return doctor.run(rest, io);
    case "setup":
      return setup.run(rest, io);
    case "update":
      return update.run(rest, io);
    default:
      io.err(`kairoku: unknown command ${JSON.stringify(command)}\n\n${usage}`);
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), io));
