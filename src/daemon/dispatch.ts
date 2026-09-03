/**
 * A dispatch becomes a TEAM (§20.4), and the state that must survive a restart
 * (RF-013).
 *
 * One dispatch, one daemon (grill Q4), one member per item — each in its own
 * worktree on its own branch, fanned out up to this machine's capacity. The
 * recipe decides who runs when; this module is what turns the recipe's abstract
 * `runRole` and `qa` into real providers, a real worktree and real reports, and
 * what writes the one file per run that a restart reads.
 *
 * The daemon still reports FACTS: the branch it cut, a PR url if the agent
 * opened one, the four counts the QA step measured, the curated events. It
 * never decides whether the work was good — the reviewer's structured verdict
 * and the suite do that, and the app owns the row.
 *
 * Nothing here talks to the app. `link.ts` carries what this module reports.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimItem, ClaimedDispatch, RunReport, RunState, SuiteCounts } from "./app";
import type { Config } from "./config";
import { ensureRunDir, runDir, stdoutPath } from "./events";
import type { RoleName } from "./policy";
import { providerRegistry, resolvePluginPath, type Provider, type ProviderName } from "./providers";
import { qaPlan, runQa } from "./qa";
import { leadRole, recipeFor, schemaFor, type MemberContext, type MemberOutcome } from "./recipes";
import { childEnv, RunStore } from "./runs";
import { run as execArgv } from "./worktree";

/** The four states a run's json can be in; the last two are terminal. */
export type RunPhase = "starting" | "running" | "done" | "failed";

export interface RunStateFile {
  readonly dispatchId: string;
  readonly runId: string;
  readonly state: RunPhase;
  /** The DAEMON's pid — a member is a piece of this process now, not a child of it. */
  readonly pid?: number;
  readonly startedAt: string;
  readonly branch: string;
  readonly worktree?: string;
  readonly sessionId?: string;
  /** A terminal report the app has not accepted yet. Retried until it does. */
  readonly report?: RunReport;
}

export interface DispatchDeps {
  /** The interim `KAIROKU_PAT` when an item carried no run token (§20.7). */
  readonly agentToken?: string;
  /** `owner/name` of the configured checkout, when it is known. */
  readonly repoFullName?: string;
  /** Extra environment every agent gets — the app origin the MCP server dials. */
  readonly agentEnv?: Record<string, string>;
  /** One report about one run, delivered or queued by the caller. */
  readonly report?: (report: RunReport) => void;
  readonly providers?: Record<ProviderName, Provider>;
  readonly pluginPath?: string;
  readonly findPrUrl?: (repoPath: string, branch: string) => Promise<string | undefined>;
}

export interface StartedDispatch {
  readonly dispatchId: string;
  readonly runIds: string[];
  readonly finished: Promise<void>;
}

// --------------------------------------------------------------- the run file

export function runStatePath(runsDir: string, dispatchId: string, runId: string): string {
  return join(runDir(runsDir, dispatchId), `${runId}.json`);
}

export function writeRunState(runsDir: string, state: RunStateFile): void {
  try {
    ensureRunDir(runsDir, state.dispatchId);
    writeFileSync(runStatePath(runsDir, state.dispatchId, state.runId), JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Losing the breadcrumb costs one restart report, never the run itself.
  }
}

export function readRunStates(runsDir: string): RunStateFile[] {
  const out: RunStateFile[] = [];
  let dispatchIds: string[];
  try {
    dispatchIds = readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const dispatchId of dispatchIds) {
    let files: string[];
    try {
      files = readdirSync(runDir(runsDir, dispatchId));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(runDir(runsDir, dispatchId), file), "utf8")) as RunStateFile;
        if (parsed && typeof parsed.dispatchId === "string" && typeof parsed.runId === "string") out.push(parsed);
      } catch {
        // Not a run file, or a half-written one. Neither is a reason to refuse to boot.
      }
    }
  }
  return out;
}

/**
 * Is a recorded pid still the process that recorded it?
 *
 * PID ALONE IS NOT ENOUGH and the difference is not theoretical: pids are
 * recycled, so a dead daemon's number can belong to an unrelated process by the
 * time we look, and reaping on "the pid is gone" alone would then decline to
 * reap a genuinely stranded run forever. Asking the OS when that pid started
 * and comparing it to the run's own start time settles it. Unreadable — no
 * `ps`, no permission, a platform we do not know — is treated as "not ours",
 * which reaps, because a stranded run reported failed is recoverable and a
 * run left `running` in the app forever is not.
 */
export async function processStartedBefore(pid: number, iso: string, exec = execArgv): Promise<boolean> {
  try {
    const result = await exec(["ps", "-o", "lstart=", "-p", String(pid)], process.cwd());
    const started = Date.parse(result.stdout.trim());
    if (result.code !== 0 || Number.isNaN(started)) return false;
    // One second of slack: `ps` prints whole seconds and the run file is stamped
    // some milliseconds after the process began.
    return started <= Date.parse(iso) + 1_000;
  } catch {
    return false;
  }
}

export interface SweepDeps {
  readonly selfPid?: number;
  readonly owned?: (pid: number, startedAt: string) => Promise<boolean>;
}

/**
 * RF-013 — the boot rule. A run left non-terminal by a daemon that died is
 * marked failed on disk and handed back so the link can tell the app
 * "daemon restarted".
 *
 * IT IS NEVER RELAUNCHED. Re-running a prompt whose first attempt may have
 * committed, pushed or opened a PR is the §20 lesson: a duplicate run is a far
 * worse failure than a stuck row, and the human decides what to do next.
 */
export async function sweepRestarts(runsDir: string, deps: SweepDeps = {}): Promise<RunStateFile[]> {
  const selfPid = deps.selfPid ?? process.pid;
  const owned = deps.owned ?? ((pid, startedAt) => processStartedBefore(pid, startedAt));
  const stranded: RunStateFile[] = [];
  for (const state of readRunStates(runsDir)) {
    if (state.state === "done" || state.state === "failed") continue;
    // Our own pid on a run we have not started means the number was recycled
    // onto us: the owner is gone.
    if (state.pid !== undefined && state.pid !== selfPid && (await owned(state.pid, state.startedAt))) continue;
    writeRunState(runsDir, { ...state, state: "failed" });
    stranded.push(state);
  }
  return stranded;
}

/** Terminal reports the app never accepted, for the beat to retry (§20 item 9). */
export function pendingReports(runsDir: string): RunReport[] {
  return readRunStates(runsDir)
    .filter((state) => state.report !== undefined)
    .map((state) => state.report!);
}

export function clearPendingReport(runsDir: string, dispatchId: string, runId: string): void {
  const path = runStatePath(runsDir, dispatchId, runId);
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as RunStateFile;
    const { report: _dropped, ...rest } = state;
    writeFileSync(path, JSON.stringify(rest, null, 2) + "\n");
  } catch {
    // No file, or one we cannot read. The report is already gone either way.
  }
}

// ---------------------------------------------------------------- the PR url

export interface PrLookupDeps {
  /** The absolute path of a forge CLI, or null when this machine has none. */
  which(bin: string): string | null;
  exec(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

const realPrLookup: PrLookupDeps = {
  // The PATH is read at CALL time, not at import time: a service manager sets
  // the daemon's PATH after the module graph is built, and `Bun.which(bin)`
  // with no options answers from the PATH the process started with.
  which: (bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }),
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
  // The RESOLVED path is what runs, not the bare name: `which` and `spawn`
  // answering from two different PATHs is how a lookup checks one binary and
  // then runs another.
  const gh = deps.which("gh");
  if (gh) {
    const r = await deps.exec([gh, "pr", "view", branch, "--json", "url", "--jq", ".url"], repoPath);
    const url = r.stdout.trim();
    if (r.code === 0 && url.startsWith("http")) return url;
  }
  const glab = deps.which("glab");
  if (glab) {
    const r = await deps.exec([glab, "mr", "view", branch, "-F", "json"], repoPath);
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

// ------------------------------------------------------------- the team's shape

/**
 * §20.9 — one checkout per daemon. A claim for another repo is REPORTED, with
 * the reason, rather than attempted or left to time out.
 *
 * It FAILS CLOSED. An unknown `repoFullName` (the checkout has no origin, or
 * git could not be asked) is a mismatch, not a pass. A claim that names no repo
 * at all still runs — that is the app saying "wherever you are". Comparison is
 * case-insensitive and the `.git` suffix is stripped on BOTH sides: the app
 * should never send one, and a guard that trusts that is a guard that breaks
 * the first time it is wrong.
 */
export function checkoutMismatch(dispatch: ClaimedDispatch, repoFullName?: string): string | undefined {
  const wanted = dispatch.repo?.fullName;
  if (!wanted) return undefined;
  return normaliseRepo(wanted) === normaliseRepo(repoFullName) && repoFullName ? undefined : wanted;
}

const normaliseRepo = (name?: string): string => (name ?? "").trim().replace(/\.git$/i, "").toLowerCase();

/** The team the app chose, or the one its task type implies (§20.4 defaults). */
export function recipeName(dispatch: ClaimedDispatch): string {
  const chosen = dispatch.team?.recipe;
  if (typeof chosen === "string" && chosen !== "") return chosen;
  if (dispatch.taskType === "plan") return "plan";
  if (dispatch.taskType === "research" || dispatch.taskType === "document") return "research";
  return dispatch.target?.kind === "phase" || dispatch.target?.kind === "release" ? "phase-team" : "build-verify";
}

export interface RoleChoice {
  readonly provider: ProviderName;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Provider and model per role, from the dispatch's `team.roles`; Claude by default. */
export function roleChoice(dispatch: ClaimedDispatch, role: RoleName): RoleChoice {
  const chosen = dispatch.team?.roles?.[role];
  const provider = chosen?.provider === "codex" ? "codex" : "claude";
  const effort = (EFFORTS as readonly string[]).includes(chosen?.effort ?? "")
    ? (chosen!.effort as RoleChoice["effort"])
    : undefined;
  return {
    provider,
    ...(chosen?.model ? { model: chosen.model } : {}),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** `run/<dispatchId>` for one member; `run/<dispatchId>-<n>` for a team. */
export function memberName(dispatchId: string, index: number, total: number): string {
  return total === 1 ? dispatchId : `${dispatchId}-${index + 1}`;
}

// ------------------------------------------------------------------ the run

export function startDispatch(
  store: RunStore,
  config: Config,
  dispatch: ClaimedDispatch,
  deps: DispatchDeps = {},
): StartedDispatch {
  const runsDir = config.runsDir;
  const id = dispatch.id;
  const report = deps.report ?? (() => {});
  const items = dispatch.items ?? [];

  const refuseAll = (summary: string): StartedDispatch => {
    ensureRunDir(runsDir, id);
    const runIds = items.length ? items.map((item) => item.runId) : [id];
    for (const runId of runIds) {
      const failed: RunReport = { dispatchId: id, runId, status: "failed", summary: summary.slice(0, 500) };
      writeRunState(runsDir, {
        dispatchId: id,
        runId,
        state: "failed",
        startedAt: new Date().toISOString(),
        branch: `run/${id}`,
        report: failed,
      });
      report(failed);
    }
    return { dispatchId: id, runIds, finished: Promise.resolve() };
  };

  const otherRepo = checkoutMismatch(dispatch, deps.repoFullName);
  if (otherRepo) return refuseAll(`no checkout for ${otherRepo}`);

  const name = recipeName(dispatch);
  const recipe = recipeFor(name);
  if (!recipe) return refuseAll(`this daemon has no team called "${name}" — upgrade it or pick another`);
  if (items.length === 0) return refuseAll("the claim carried no items, so there is nothing to run");

  const registry = deps.providers ?? providerRegistry();
  const pluginPath = deps.pluginPath ?? resolvePluginPath();
  const findPr = deps.findPrUrl ?? ((repoPath, branch) => findPrUrl(repoPath, branch));
  const base = `origin/${dispatch.repo?.defaultBranch ?? config.defaultBranch}`;
  const timeoutSec = dispatch.limits?.runSeconds ?? config.defaultTimeoutSec;
  const lead = leadRole(name);

  const finished = fanOut(items, config.maxConcurrent, (item, index) =>
    runMember({
      store,
      config,
      dispatch,
      item,
      name: memberName(id, index, items.length),
      recipe,
      lead,
      base,
      timeoutSec,
      registry,
      ...(pluginPath === undefined ? {} : { pluginPath }),
      findPr,
      report,
      ...(deps.agentToken === undefined ? {} : { agentToken: deps.agentToken }),
      ...(deps.agentEnv === undefined ? {} : { agentEnv: deps.agentEnv }),
    }),
  );

  return { dispatchId: id, runIds: items.map((item) => item.runId), finished };
}

/**
 * At most `limit` members at once. A worker pool rather than a chunked
 * `Promise.all`: with three items and capacity two, the third starts the moment
 * either of the first two finishes, rather than waiting for both.
 */
async function fanOut<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await run(next.item, next.index);
    }
  });
  await Promise.all(workers);
}

interface MemberArgs {
  store: RunStore;
  config: Config;
  dispatch: ClaimedDispatch;
  item: ClaimItem;
  name: string;
  recipe: (ctx: MemberContext) => Promise<MemberOutcome>;
  lead: RoleName;
  base: string;
  timeoutSec: number;
  registry: Record<ProviderName, Provider>;
  pluginPath?: string;
  findPr: (repoPath: string, branch: string) => Promise<string | undefined>;
  report: (report: RunReport) => void;
  agentToken?: string;
  agentEnv?: Record<string, string>;
}

async function runMember(args: MemberArgs): Promise<void> {
  const { config, dispatch, item, store, report } = args;
  const runsDir = config.runsDir;
  const dispatchId = dispatch.id;
  const runId = item.runId;
  const startedAt = new Date().toISOString();
  const branch = `run/${args.name}`;

  const pat = item.runToken || args.agentToken;
  if (!pat) {
    const failed: RunReport = {
      dispatchId,
      runId,
      status: "failed",
      summary: "no run token in the claim and no KAIROKU_AGENT_TOKEN configured — the agent would have no credential",
    };
    writeRunState(runsDir, { dispatchId, runId, state: "failed", startedAt, branch, report: failed });
    report(failed);
    return;
  }

  const env = childEnv({ ...(args.agentEnv ?? {}), KAIROKU_PAT: pat });
  let sessionId: string | undefined;
  let outcome: MemberOutcome = { ok: false, summary: "the member produced no outcome" };

  const save = (state: RunPhase, extra: Partial<RunStateFile> = {}) =>
    writeRunState(runsDir, {
      dispatchId,
      runId,
      state,
      pid: process.pid,
      startedAt,
      branch,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...extra,
    });

  save("starting");

  const result = await store.start({
    dispatchId,
    runId,
    name: args.name,
    role: args.lead,
    base: args.base,
    timeoutSec: args.timeoutSec,
    // The run's own credential is masked out of every event and every log.
    secrets: [pat],
    onStarted: ({ worktree }) => {
      save("running", { worktree });
      // §20 addendum 6 — EVERY run says `running` once at launch. A dispatch
      // whose progress showed only in the beat's `runs[].state` would stay
      // `claimed` in the app and be re-claimable after the lease.
      report({ dispatchId, runId, status: "running", state: "running", role: args.lead });
    },
    execute: async (ctx) => {
      const cwd = ctx.worktree.path;
      const plan = qaPlan(cwd);
      const memberCtx: MemberContext = {
        item: { id: item.id, key: item.key, title: item.title, body: item.body },
        brief: dispatch.brief ?? "",
        worktree: cwd,
        cancelled: ctx.cancelled,
        qa: () => runQa(cwd, { plan }),
        runRole: async (role, prompt) => {
          ctx.setState("running", role);
          const choice = roleChoice(dispatch, role);
          const provider = args.registry[choice.provider];
          const launched = provider.launch({
            dispatchId,
            runId,
            role,
            prompt,
            cwd,
            env,
            timeoutMs: args.timeoutSec * 1000,
            logPath: stdoutPath(runsDir, dispatchId, runId),
            ...(choice.model === undefined ? {} : { model: choice.model }),
            ...(choice.effort === undefined ? {} : { effort: choice.effort }),
            ...(schemaFor(role) === undefined ? {} : { schema: schemaFor(role)! }),
          });
          ctx.attach(launched);
          const pump = (async () => {
            for await (const event of launched.events) ctx.events.push(event.kind, event.text);
          })();
          const exit = await launched.exit;
          await pump;
          ctx.attach(undefined);
          if (exit.sessionId) {
            sessionId = exit.sessionId;
            save("running", { worktree: cwd });
          }
          ctx.events.push(exit.ok ? "ok" : "error", `${role} (${choice.provider}): ${exit.summary}`);
          return { ok: exit.ok, summary: exit.summary, ...(exit.report === undefined ? {} : { report: exit.report }) };
        },
      };
      outcome = await args.recipe(memberCtx);
      return { ok: outcome.ok, summary: outcome.summary };
    },
  });

  const ok = result.status === "idle";
  // Asked of the base checkout, not the worktree: the worktree is torn down by
  // the time a run is terminal, and the branch is what the forge knows.
  const prUrl = await args.findPr(config.repoPath, result.branch).catch(() => undefined);
  const counts = outcome.counts;
  const documentIds = readDocumentIds(outcome.report);

  const terminal: RunReport = {
    dispatchId,
    runId,
    role: args.lead,
    status: ok ? "done" : "failed",
    state: "finishing",
    summary: result.exitSummary.slice(0, 500),
    artifacts: {
      branch: result.branch,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(documentIds === undefined ? {} : { documentIds }),
    },
    // A `failed` report needs no counts; a `done` implement run does, and a run
    // that never measured a suite has already failed for exactly that reason.
    ...(counts === undefined ? {} : { counts: counts as SuiteCounts }),
  };

  save(ok ? "done" : "failed", { worktree: result.worktree, report: terminal });
  report(terminal);
}

function readDocumentIds(report: unknown): string[] | undefined {
  const ids = (report as { documentIds?: unknown } | undefined)?.documentIds;
  if (!Array.isArray(ids)) return undefined;
  const strings = ids.filter((id): id is string => typeof id === "string");
  return strings.length ? strings : undefined;
}

/** What the Floor prints while a member is between roles. Exported for `/status`. */
export type { RunState };
