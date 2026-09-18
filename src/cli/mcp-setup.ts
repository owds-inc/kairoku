/**
 * `kairoku mcp setup` — wire this CLI's `mcp-bridge` into codex and/or
 * Claude Code as a stdio MCP server, so a coding agent gets the human's
 * Kairoku MCP access without its own OAuth ceremony. Requires a prior
 * `kairoku login`.
 */

import { parseArgs } from "node:util";
import { readMcpLogin } from "./login";
import type { Io } from "./io";

export const usage = `usage: kairoku mcp setup [--agent codex|claude|all]

  Registers this CLI as a stdio MCP server (\`kairoku mcp-bridge\`) with the
  named coding agent(s). Requires \`kairoku login\` first. Default: every
  agent present on this machine.

  --agent <name>   codex, claude, or all [all]`;

/** The absolute command this machine's own CLI runs as, for the agent's own argv. */
export function bridgeCommand(io: Io): string {
  return io.execPath;
}

async function setupCodex(io: Io, command: string): Promise<number> {
  if (!io.which("codex")) {
    io.out("codex: not found on PATH — skipped");
    return 0;
  }
  // §21 item 5b's URL entry (or any prior kairoku entry) is replaced, not
  // layered: two `[mcp_servers.kairoku]` blocks is a Codex config a human
  // has to hand-edit to fix.
  await io.shell(["codex", "mcp", "remove", "kairoku"]);
  const add = await io.shell(["codex", "mcp", "add", "kairoku", "--command", command, "--args", "mcp-bridge"]);
  if (add.code !== 0) {
    io.err(`codex mcp add failed (exit ${add.code}): ${add.stderr.trim()}`);
    return 1;
  }
  io.out(`codex: kairoku → ${command} mcp-bridge`);
  return 0;
}

async function setupClaude(io: Io, command: string): Promise<number> {
  if (!io.which("claude")) {
    io.out("claude: not found on PATH — skipped");
    return 0;
  }
  const add = await io.shell([
    "claude",
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    "kairoku",
    "--",
    command,
    "mcp-bridge",
  ]);
  if (add.code !== 0) {
    io.err(`claude mcp add failed (exit ${add.code}): ${add.stderr.trim()}`);
    return 1;
  }
  io.out(`claude: kairoku → ${command} mcp-bridge`);
  return 0;
}

export async function run(args: string[], io: Io): Promise<number> {
  let values: { agent?: string; help?: boolean };
  try {
    values = parseArgs({ args, options: { agent: { type: "string" }, help: { type: "boolean", short: "h" } } }).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${usage}`);
    return 2;
  }
  if (values.help) {
    io.out(usage);
    return 0;
  }

  if (!readMcpLogin(io)) {
    io.err("mcp setup: not logged in — run `kairoku login` first");
    return 1;
  }

  const agent = values.agent ?? "all";
  if (!["codex", "claude", "all"].includes(agent)) {
    io.err(`mcp setup: unknown --agent ${JSON.stringify(agent)} — codex, claude or all`);
    return 2;
  }

  io.out("pi: not configured (kairokud manages pi inside runs)");

  const command = bridgeCommand(io);
  let code = 0;
  if (agent === "codex" || agent === "all") code ||= await setupCodex(io, command);
  if (agent === "claude" || agent === "all") code ||= await setupClaude(io, command);
  return code;
}
