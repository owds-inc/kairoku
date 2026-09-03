/**
 * §21 Q15/Q19 — CodeGraph, on probation, opt-in per repo.
 *
 * A repo asks for it once, in `kairoku.json` (`intelligence: ["codegraph"]`).
 * When it has, this module indexes each run's worktree before the first role
 * launches and hands the run an MCP server pointed at that index — Claude
 * through the SDK's `mcpServers` option, Codex through a `[mcp_servers.codegraph]`
 * table in the worktree's own `.codex/config.toml`.
 *
 * ONE INDEX PER WORKTREE, AND THAT IS NOT A CHOICE. CodeGraph refuses to share
 * a `.codegraph` across git worktrees ("a single index can't correctly represent
 * multiple branches at once" — issues #155 and #1236), so N concurrent members
 * means N cold indexes and the project path is PINNED with `-p` rather than left
 * to a client `rootUri` this daemon never sends.
 *
 * IT DEGRADES SILENTLY (§21 item 3). No `codegraph` on the machine, an index
 * that fails, a lock held by another process: the run proceeds without it, and
 * `kairoku doctor` is where an operator learns the machine has none. It is a
 * probation, not a dependency — the opposite of `rules.ts`, which fails the run
 * CLOSED, because a rule nobody checked is a false clean report and an index
 * nobody built is only a slower agent.
 *
 * codegraph is a BINARY, not an import: §20.2's one-runtime-dependency rule is
 * untouched. It is spawned through the path `which` RESOLVED, which is rule 3's
 * own lesson.
 */

import { excludeFromGit, run as execArgv, type CommandResult } from "./worktree";

/** The binary. Named in the doctor line so an operator knows what to install. */
export const CODEGRAPH = "codegraph";

/** What it writes into the worktree, and the line added to the checkout's exclude. */
export const CODEGRAPH_DIR = ".codegraph";

/**
 * §21 item 2 — the one sentence the role prompts get, and only when the index
 * is actually there. A static line in `roles/*.md` would advertise a tool that
 * does not exist on every run of every repo that did not opt in.
 */
export const CODEGRAPH_NOTE =
  "`codegraph_explore` is available for orientation and blast radius; read the file before you edit it.";

/** One run's index. Absent from a `RoleRun` means this run has none. */
export interface CodeGraph {
  /** The RESOLVED codegraph path, never the bare name. */
  readonly bin: string;
  /** The worktree this index belongs to; `-p` for the MCP server. */
  readonly worktree: string;
}

export interface IndexedWorktree {
  /** Handed to every role turn. Absent when there is no usable index. */
  readonly codegraph?: CodeGraph;
  /** One curated line for the run's log. Absent when nothing was attempted. */
  readonly event?: string;
}

export interface IndexDeps {
  readonly which?: (bin: string) => string | null;
  readonly exec?: (argv: string[], cwd: string) => Promise<CommandResult>;
  /** The wall clock, as a seam so the event line is exact under test. */
  readonly now?: () => number;
}

const realWhich = (bin: string): string | null => Bun.which(bin, { PATH: process.env.PATH ?? "" });

/**
 * Index this worktree, and time it (§21 item 2 and Q19's second number).
 *
 * The count comes from `codegraph status --json` rather than from `init`'s own
 * stdout: that output is a progress renderer full of ANSI, and a regex over it
 * is a line that breaks on the next release. `status --json` is the documented
 * structured surface and carries `fileCount` directly.
 */
export async function indexWorktree(worktree: string, deps: IndexDeps = {}): Promise<IndexedWorktree> {
  const which = deps.which ?? realWhich;
  const exec = deps.exec ?? execArgv;
  const now = deps.now ?? Date.now;

  const bin = which(CODEGRAPH);
  if (!bin) return {};

  // Before the index exists, so a failed one still leaves nothing committable.
  excludeFromGit(worktree, [`${CODEGRAPH_DIR}/`]);

  const started = now();
  let init: CommandResult;
  try {
    init = await exec([bin, "init", worktree], worktree);
  } catch (err) {
    return { event: `${CODEGRAPH}: not indexed — ${message(err)}` };
  }
  const seconds = ((now() - started) / 1000).toFixed(1);
  if (init.code !== 0) {
    return { event: `${CODEGRAPH}: not indexed — ${firstLine(init.stderr || init.stdout)}` };
  }

  const codegraph: CodeGraph = { bin, worktree };
  const files = await fileCount(bin, worktree, exec);
  return {
    codegraph,
    event: files === undefined ? `${CODEGRAPH}: indexed in ${seconds}s` : `${CODEGRAPH}: ${files} files in ${seconds}s`,
  };
}

/** `fileCount` from `status --json`, or `undefined` — never a guessed zero. */
async function fileCount(
  bin: string,
  worktree: string,
  exec: (argv: string[], cwd: string) => Promise<CommandResult>,
): Promise<number | undefined> {
  try {
    const status = await exec([bin, "status", "--json", worktree], worktree);
    const parsed = JSON.parse(status.stdout) as { fileCount?: unknown };
    return typeof parsed.fileCount === "number" ? parsed.fileCount : undefined;
  } catch {
    // A status this daemon cannot read costs the count in one log line. The
    // index itself is built and the server below still serves it.
    return undefined;
  }
}

/** The stdio server, for the SDK's `mcpServers` option. */
export function codegraphMcpServers(codegraph: CodeGraph): Record<string, unknown> {
  return { codegraph: { type: "stdio", command: codegraph.bin, args: serveArgs(codegraph) } };
}

/** The same server, in the form Codex's project config takes (TOML, not JSON). */
export function codegraphTomlTable(codegraph: CodeGraph): string {
  return [
    "[mcp_servers.codegraph]",
    `command = ${JSON.stringify(codegraph.bin)}`,
    `args = [${serveArgs(codegraph).map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "",
  ].join("\n");
}

const serveArgs = (codegraph: CodeGraph): string[] => ["serve", "--mcp", "-p", codegraph.worktree];

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "no output";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
