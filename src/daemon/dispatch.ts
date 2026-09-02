/**
 * A dispatch becomes a run (§20 item 4), and the one piece of state that must
 * survive a restart (RF-013).
 *
 * The daemon reports FACTS: the branch it cut, a PR url if the agent opened
 * one, the four counts if the agent cited a suite, the local jsonl path. It
 * never decides whether the work was good — the app does that, and a 422 from
 * `update` is logged and the run marked failed locally.
 *
 * Nothing here talks to the app. `link.ts` carries what this module returns.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimedDispatch, RunArtifacts, SuiteCounts } from "./app";
import { runTokenOf } from "./app";
import type { Config } from "./config";
import { eventsPath, ensureRunDir, runDir, stdoutPath } from "./events";
import type { RunStore } from "./runs";
import { run as execArgv } from "./worktree";

/** The four states a `run.json` can be in; the last two are terminal. */
export type RunPhase = "starting" | "running" | "done" | "failed";

export interface RunState {
  readonly dispatchId: string;
  readonly state: RunPhase;
  readonly pid?: number;
  readonly startedAt: string;
  readonly branch: string;
  readonly worktree?: string;
}

export interface DispatchReport {
  readonly dispatchId: string;
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly artifacts: RunArtifacts;
  readonly counts?: SuiteCounts;
}

export interface StartedDispatch {
  readonly dispatchId: string;
  readonly branch: string;
  readonly finished: Promise<DispatchReport>;
}

export interface DispatchDeps {
  /** The interim `KAIROKU_PAT` when the claim carried no run token (§20.7). */
  readonly agentToken?: string;
  /** `owner/name` of the configured checkout, when it is known. */
  readonly repoFullName?: string;
  /** Fired once the agent is spawned — where `update running` hangs. */
  readonly onRunning?: (started: { branch: string; pid?: number }) => void;
  readonly findPrUrl?: (repoPath: string, branch: string) => Promise<string | undefined>;
}

// --------------------------------------------------------------- run.json

export function runStatePath(runsDir: string, dispatchId: string): string {
  return join(runDir(runsDir, dispatchId), "run.json");
}

export function writeRunState(runsDir: string, state: RunState): void {
  try {
    writeFileSync(runStatePath(runsDir, state.dispatchId), JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Losing the breadcrumb costs one restart report, never the run itself.
  }
}

export function readRunStates(runsDir: string): RunState[] {
  let ids: string[];
  try {
    ids = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: RunState[] = [];
  for (const id of ids) {
    try {
      const parsed = JSON.parse(readFileSync(runStatePath(runsDir, id), "utf8")) as RunState;
      if (parsed && typeof parsed.dispatchId === "string") out.push(parsed);
    } catch {
      // Not a run dir, or a half-written file. Neither is a reason to refuse to boot.
    }
  }
  return out;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * RF-013 — the boot rule. A run left non-terminal by a daemon that died is
 * marked failed on disk and handed back so the link can tell the app
 * "daemon restarted".
 *
 * IT IS NEVER RELAUNCHED. Re-running a prompt whose first attempt may have
 * committed, pushed or opened a PR is the §20 lesson: a duplicate run is a far
 * worse failure than a stuck row, and the human decides what to do next.
 */
export function sweepRestarts(runsDir: string, alive: (pid: number) => boolean = pidAlive): RunState[] {
  const stranded: RunState[] = [];
  for (const state of readRunStates(runsDir)) {
    if (state.state === "done" || state.state === "failed") continue;
    if (state.pid !== undefined && alive(state.pid)) continue;
    writeRunState(runsDir, { ...state, state: "failed" });
    stranded.push(state);
  }
  return stranded;
}

// ---------------------------------------------------------------- the report

/**
 * The four counts out of the agent's final report block.
 *
 * The block is searched for from the end, because a run that cites a suite
 * twice means the second one. It is tried twice: once raw, and once with `\"`
 * unescaped — `codex exec --json` delivers the agent's own text inside a JSON
 * string, so the braces the block needs arrive escaped.
 *
 * ponytail: a two-pass unescape rather than walking every JSONL event's string
 * values; if a provider nests deeper than one level, parse its event stream
 * properly in the O-3 provider module instead.
 */
export function parseCounts(text: string): SuiteCounts | undefined {
  for (const candidate of [text, text.replace(/\\"/g, '"')]) {
    const counts = scanForCounts(candidate);
    if (counts) return counts;
  }
  return undefined;
}

function scanForCounts(text: string): SuiteCounts | undefined {
  let from = text.length;
  for (;;) {
    const marker = text.lastIndexOf('"kairoku"', from);
    if (marker < 0) return undefined;
    from = marker - 1;
    const open = text.lastIndexOf("{", marker);
    if (open < 0) continue;
    const block = balancedObject(text, open);
    if (!block) continue;
    try {
      const counts = (JSON.parse(block) as { kairoku?: { counts?: unknown } }).kairoku?.counts;
      if (isCounts(counts)) return counts;
    } catch {
      // Not the block; keep looking further back.
    }
  }
}

/** The `{…}` starting at `open`, brace-counted with strings respected. */
function balancedObject(text: string, open: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

function isCounts(value: unknown): value is SuiteCounts {
  const c = value as Record<string, unknown> | null;
  return (
    !!c && ["pass", "fail", "skip", "errors"].every((k) => typeof c[k] === "number" && Number.isFinite(c[k] as number))
  );
}

export interface PrLookupDeps {
  which(bin: string): boolean;
  exec(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const realPrLookup: PrLookupDeps = {
  which: (bin) => Bun.which(bin) !== null,
  exec: (argv, cwd) => execArgv(argv, cwd),
};

/**
 * The PR url for a branch, asked of whichever forge CLI is installed. No PR is
 * not an error: the branch is the deliverable and the human opens the PR when
 * the agent did not.
 */
export async function findPrUrl(
  repoPath: string,
  branch: string,
  deps: PrLookupDeps = realPrLookup,
): Promise<string | undefined> {
  if (deps.which("gh")) {
    const r = await deps.exec(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], repoPath);
    const url = r.stdout.trim();
    if (r.code === 0 && url.startsWith("http")) return url;
  }
  if (deps.which("glab")) {
    const r = await deps.exec(["glab", "mr", "view", branch, "-F", "json"], repoPath);
    if (r.code === 0) {
      try {
        const url = (JSON.parse(r.stdout) as { web_url?: unknown }).web_url;
        if (typeof url === "string" && url.startsWith("http")) return url;
      } catch {
        // glab printed something else; no url is the honest answer.
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------- the run itself

/**
 * §20.9 — one checkout per daemon. A claim for another repo is REPORTED, with
 * the reason, rather than attempted or left to time out. A repo map with
 * auto-clone is the follow-up, not a silent hang.
 */
function checkoutMismatch(dispatch: ClaimedDispatch, repoFullName?: string): string | undefined {
  const wanted = dispatch.repo?.fullName;
  if (!wanted || !repoFullName) return undefined;
  return wanted === repoFullName ? undefined : wanted;
}

export function startDispatch(
  store: RunStore,
  config: Config,
  dispatch: ClaimedDispatch,
  deps: DispatchDeps = {},
): StartedDispatch {
  const runsDir = config.runsDir;
  const id = dispatch.id;
  const branch = `run/${id}`;
  const startedAt = new Date().toISOString();

  const refuse = (summary: string): StartedDispatch => {
    ensureRunDir(runsDir, id);
    writeRunState(runsDir, { dispatchId: id, state: "failed", startedAt, branch });
    return {
      dispatchId: id,
      branch,
      finished: Promise.resolve({
        dispatchId: id,
        status: "failed",
        summary,
        artifacts: { jsonl: eventsPath(runsDir, id) },
      }),
    };
  };

  const otherRepo = checkoutMismatch(dispatch, deps.repoFullName);
  if (otherRepo) return refuse(`no checkout for ${otherRepo}`);

  const pat = runTokenOf(dispatch) ?? deps.agentToken;
  if (!pat) {
    return refuse(
      "no run token in the claim and no KAIROKU_AGENT_TOKEN configured — the agent would have no credential",
    );
  }

  ensureRunDir(runsDir, id);
  writeRunState(runsDir, { dispatchId: id, state: "starting", startedAt, branch });

  const base = `origin/${dispatch.repo?.defaultBranch ?? config.defaultBranch}`;
  const findPr = deps.findPrUrl ?? ((repoPath, br) => findPrUrl(repoPath, br));
  // Carried forward so the terminal run.json still names the process that ran
  // and the worktree that was cut — a post-mortem reads that file, not a log.
  let launched: { pid?: number; worktree?: string } = {};

  const finished = store
    .start({
      id,
      brief: dispatch.brief,
      env: { KAIROKU_PAT: pat },
      base,
      onStarted: ({ pid, worktree }) => {
        launched = { pid, worktree };
        writeRunState(runsDir, { dispatchId: id, state: "running", pid, startedAt, branch, worktree });
        deps.onRunning?.({ branch, pid });
      },
    })
    .then(async (result): Promise<DispatchReport> => {
      const status = result.status === "idle" ? "done" : "failed";
      const counts = parseCounts(readText(stdoutPath(runsDir, id)));
      // Asked of the base checkout, not the worktree: the worktree is torn down
      // by the time a run is terminal, and the branch is what the forge knows.
      const prUrl = await findPr(config.repoPath, result.branch).catch(() => undefined);

      writeRunState(runsDir, { dispatchId: id, ...launched, state: status, startedAt, branch: result.branch });

      return {
        dispatchId: id,
        status,
        summary: `${result.exitSummary} on ${result.branch}`.slice(0, 500),
        artifacts: {
          branch: result.branch,
          jsonl: eventsPath(runsDir, id),
          ...(prUrl === undefined ? {} : { prUrl }),
        },
        ...(counts === undefined ? {} : { counts }),
      };
    });

  return { dispatchId: id, branch, finished };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
