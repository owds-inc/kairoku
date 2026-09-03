/**
 * §20.8 — permissions v1: a fixed policy per role, as DATA, and one function
 * that applies it.
 *
 * ONE DECIDER, TWO CALLERS. The Claude provider installs `decide()` as an
 * unconditional `PreToolUse` hook and the codex provider derives its sandbox
 * mode from the same table, so the two providers cannot drift into different
 * ideas of what a reviewer may do. Answering a permission request from the app
 * is a later layer; there is no "ask" here, only allow and deny.
 *
 * IT FAILS CLOSED at every branch: an unknown role, an unlisted tool, a write
 * whose path cannot be read, and a path that resolves outside the run's own
 * worktree are all denials. Every denial carries the reason, because the reason
 * is what reaches the model (so it can correct itself) and the `deny` event (so
 * a human can see what the agent tried).
 */

import { isAbsolute, relative, resolve } from "node:path";

export const ROLE_NAMES = ["implementer", "reviewer", "planner", "researcher"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * QA IS NOT A ROLE (grill Q2). It is a deterministic daemon step — see `qa.ts`
 * — so there is nothing here for it to be allowed to do.
 */
export function isRole(name: string): name is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(name);
}

/** The MCP server a run's token is scoped to. Any other server is not ours. */
export const MCP_PREFIX = "mcp__kairoku__";

/**
 * §21 — the second, and only other, MCP server a run may be given: CodeGraph,
 * read-only code intelligence over the run's OWN worktree, wired only when the
 * repo opted in (`kairoku.json`'s `intelligence`). Listing it here rather than
 * gating on the flag is deliberate: `decide()` sees one tool call, not the
 * manifest, and a run that was never given the server cannot call a tool the
 * SDK never offered it. A THIRD prefix is still denied.
 */
export const CODEGRAPH_MCP_PREFIX = "mcp__codegraph__";

export interface RolePolicy {
  /**
   * `acceptEdits` for the one role that edits, so a file write never stalls on
   * a prompt the daemon has no way to answer; `dontAsk` for the rest, which
   * denies anything not pre-approved rather than waiting.
   */
  readonly permissionMode: "acceptEdits" | "dontAsk";
  /** Passed to the provider AND checked here — see `decide` on why both. */
  readonly allowedTools: readonly string[];
}

// "StructuredOutput" is the SDK's own tool for delivering an `outputFormat`
// answer (§20.8, RF-017 amendment) — denying it fails every schema-bearing
// turn closed (production, 2026-09-03: a reviewer's verdict never reached the
// daemon). The implementer runs with no schema, so the SDK never offers it
// the tool; listing it for all four roles here is simpler than a per-schema
// branch and keeps the hook and the SDK's option list agreeing.
const READ_ONLY = [
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "Skill",
  MCP_PREFIX,
  CODEGRAPH_MCP_PREFIX,
  "StructuredOutput",
] as const;

export const POLICY: Record<RoleName, RolePolicy> = {
  implementer: {
    permissionMode: "acceptEdits",
    allowedTools: [...READ_ONLY, "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"],
  },
  reviewer: {
    permissionMode: "dontAsk",
    allowedTools: [...READ_ONLY, "Bash"],
  },
  planner: {
    permissionMode: "dontAsk",
    allowedTools: [...READ_ONLY],
  },
  researcher: {
    permissionMode: "dontAsk",
    allowedTools: [...READ_ONLY, "WebSearch", "WebFetch"],
  },
};

/** The tools whose target path must be inside the run's worktree. */
const PATH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface ToolAsk {
  readonly role: string;
  readonly tool: string;
  readonly input: unknown;
  /** Absolute path of the run's worktree. */
  readonly worktree: string;
}

export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * WHY THIS EXISTS AT ALL when `allowedTools` already lists the same names:
 * `allowedTools` is one input to the CLI's permission chain and a bypass or an
 * allow rule elsewhere in that chain shadows it (`canUseTool` is last and loses
 * the same way). A `PreToolUse` hook runs FIRST and its deny wins even under
 * `bypassPermissions`, so the gate that must hold unconditionally is this one
 * and the option list is belt beside braces.
 */
export function decide(ask: ToolAsk): Decision {
  if (!isRole(ask.role)) return deny(`no tool policy for role "${ask.role}"`);
  const policy = POLICY[ask.role];

  // An entry ending in `__` is a SERVER prefix (`mcp__kairoku__`), which admits
  // every tool that server offers; everything else is an exact tool name. One
  // rule rather than one special case per server — the second server was where
  // a special case would have been copied.
  const listed = policy.allowedTools.some((allowed) =>
    allowed.endsWith("__") ? ask.tool.startsWith(allowed) : ask.tool === allowed,
  );
  if (!listed) return deny(`the ${ask.role} may not use ${ask.tool}`);

  if (!PATH_TOOLS.has(ask.tool)) return ALLOW;

  const target = (ask.input as { file_path?: unknown } | null)?.file_path;
  if (typeof target !== "string" || target === "") {
    return deny(`${ask.tool} named no file path, so it cannot be shown to be inside the worktree`);
  }
  return insideWorktree(ask.worktree, target)
    ? ALLOW
    : deny(`${ask.tool} targets ${target}, outside the run's worktree`);
}

/**
 * A relative path is resolved AGAINST THE WORKTREE, which is the agent's cwd,
 * so `src/a.ts` is inside by construction and `../escape.ts` is not.
 *
 * Exported because §21's PostToolUse hook asks the same question of the same
 * path a moment later, and two copies of "is this inside the run" is exactly
 * the drift `constraints.test.ts` exists to refuse elsewhere.
 *
 * ponytail: lexical containment, not `realpath`. A symlink planted inside the
 * worktree that points out of it would pass; the worktree is created by the
 * daemon one commit at a time and nothing in it is attacker-controlled before
 * the agent starts. Resolve for real if untrusted checkouts ever run here.
 */
export function insideWorktree(worktree: string, target: string): boolean {
  const root = resolve(worktree);
  const full = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (full === root) return true;
  const rel = relative(root, full);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * What a tool call looks like in a curated event: the name, and at most 200
 * characters of its input (§20 item 7). Never the whole input — a Write's
 * `content` is the entire file.
 */
export function toolSummary(tool: string, input: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(input) ?? "";
  } catch {
    // A cyclic or unserialisable input still tells us the name, which is the
    // part a reader needs.
    return tool;
  }
  if (serialised === "" || serialised === "{}") return tool;
  return `${tool} ${serialised.slice(0, 200)}`;
}
