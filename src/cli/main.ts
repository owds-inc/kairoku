#!/usr/bin/env bun
/**
 * kairoku — the Kairoku CLI. Dev entry (`bun run src/cli/main.ts`) and the
 * `bun build --compile` entry. The first argument picks the command; each
 * command parses the rest with node:util parseArgs and returns an exit code.
 */

import { version } from "../../package.json";
import { io, type Io } from "./io";
import * as daemon from "./daemon";
import * as doctor from "./doctor";
import * as env from "./env";
import * as login from "./login";
import * as mcpBridge from "./mcp-bridge";
import * as mcpSetup from "./mcp-setup";
import * as plugin from "./plugin";
import * as setup from "./setup";
import * as update from "./update";

export const usage = `kairoku ${version} — the Kairoku CLI

  kairoku setup [--plugin] [--daemon] [--all] [--yes]
                                   set up the Claude Code plugin and/or the daemon;
                                   a wizard without flags
  kairoku doctor                   verify this machine, change nothing; nonzero on FAIL
  kairoku daemon [install|start|stop|status|drain|update|prune|migrate]
                                   the orchestration daemon: foreground, or as a service
  kairoku login [--app-url <url>] [--resource <url>] [--replace]
                                   sign in for MCP access (a coding agent's Kairoku tools)
  kairoku logout                   remove the local MCP token; prints the revoke URL
  kairoku mcp setup [--agent codex|claude|all]
                                   wire kairoku mcp-bridge into a coding agent as stdio MCP
  kairoku mcp-bridge                stdio↔HTTP MCP bridge; run by a coding agent, not by hand
  kairoku plugin install|update|status
                                   the Claude Code plugin, through the claude CLI
  kairoku env set|import|list|rm [--repo <owner/name>] [--profile <name>]
                                   the values this machine holds for a repo's runs
  kairoku update                   replace this CLI binary with the latest release
  kairoku version
  kairoku help`;

async function mcpRun(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "setup") {
    io.err(`kairoku mcp: unknown subcommand ${JSON.stringify(sub ?? "")}\n\n${mcpSetup.usage}`);
    return 2;
  }
  return mcpSetup.run(rest, io);
}

const commands: Record<string, { usage: string; run: (args: string[], io: Io) => Promise<number> }> = {
  setup,
  doctor,
  daemon,
  plugin,
  env,
  update,
  login: { usage: login.usage, run: login.run },
  logout: { usage: login.logoutUsage, run: login.logoutRun },
  mcp: { usage: mcpSetup.usage, run: mcpRun },
  "mcp-bridge": { usage: mcpBridge.usage, run: mcpBridge.run },
};

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
  }
  const cmd = commands[command];
  if (!cmd) {
    io.err(`kairoku: unknown command ${JSON.stringify(command)}\n\n${usage}`);
    return 2;
  }
  // `--help` anywhere in a command's arguments prints that command's usage
  // and runs nothing — the same rule for every command, in one place.
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(cmd.usage);
    return 0;
  }
  return cmd.run(rest, io);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), io));
