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
import { indexWorktree, type IndexedWorktree } from "./codegraph";
import type { Config } from "./config";
import { parsePortRange, DEFAULT_PORT_RANGE } from "./compose";
import { resolveSecrets, type DeliveredSecret, type ResolverDeps } from "./env";
import { prepareEnvironment, type EnvironmentDeps } from "./environment";
import { ensureRunDir, runDir, stdoutPath } from "./events";
import { readManifest, type ManifestResult } from "./manifest";
import type { RoleName } from "./policy";
import { productionProviders, type Provider, type ProviderName } from "./providers";
import { qaPlan, runQa } from "./qa";
import { materialiseRules, scanRules, type Rules, type RulesResult } from "./rules";
import { leadRole, recipeFor, schemaFor, type MemberContext, type MemberOutcome } from "./recipes";
import { childEnv, RunStore } from "./runs";
import { run as execArgv } from "./worktree";

/** The four states a run's json can be in; the last two are terminal. */
export type RunPhase = "starting" | "running" | "done" | "failed";

/**
 * §23.4 — the stage a `phase` event names, drawn by the app as a divider
 * between turn groups. The words are the app's own (`floor-view.ts`'s
 * `RunStage`), so a divider reads as the same stage the card is painted in.
 *
 * `pr_ready`, `merged` and `queued` are NOT here and could not be: the first
 * two are the app's readings of a run it has already been told about, and the
 * last one describes a run this daemon has not started. The daemon emits only
 * what it is doing.
 */
type Stage = "implementing" | "reviewing" | "qa" | "done" | "failed";

/** Which stage a role turn is. An unknown role is work, so it implements. */
function stageForRole(role: RoleName): Stage {
  return role === "reviewer" ? "reviewing" : "implementing";
}

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
  /** O-4 — the service ports this run was allocated, for the post-mortem. */
  readonly ports?: Record<string, number>;
  /** §21 Q19 — the two numbers the CodeGraph measurement compares. */
  readonly measure?: RunMeasure;
  /** A terminal report the app has not accepted yet. Retried until it does. */
  readonly report?: RunReport;
}

/**
 * §21 Q19 — the yardstick, per member: "fewer tool calls or less wall clock per
 * item at equal-or-better QA counts". The counts are already in the terminal
 * report; these are the other two, recorded whether or not this run had an
 * index, because a measurement needs both arms.
 */
export interface RunMeasure {
  readonly toolCalls: number;
  /** Launch to the end of the team's work — teardown is daemon time, not agent time. */
  readonly wallClockMs: number;
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
  readonly findPrUrl?: (repoPath: string, branch: string) => Promise<string | undefined>;
  /** Test seam: the base branch's manifest, instead of asking git for it. */
  readonly manifest?: () => Promise<ManifestResult | undefined>;
  /** Test seam: the base branch's `.kairoku/rules`, instead of asking git. */
  readonly rules?: () => Promise<RulesResult>;
  /** Test seam: §21's index step, instead of shelling out to real CodeGraph. */
  readonly codegraph?: (worktree: string) => Promise<IndexedWorktree>;
  /** Test seam: docker and the init step. */
  readonly environment?: EnvironmentDeps;
  /** Test seam: the vault CLIs a `{ref}` is resolved through. */
  readonly resolvers?: ResolverDeps;
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

  const registry = deps.providers ?? productionProviders(config);
  const findPr = deps.findPrUrl ?? ((repoPath, branch) => findPrUrl(repoPath, branch));
  const base = `origin/${dispatch.repo?.defaultBranch ?? config.defaultBranch}`;
  // ONE read of `kairoku.json`, from the branch the worktrees are cut from, for
  // the whole dispatch (§20.11). Every member of a team runs the same contract,
  // and asking git once rather than per member keeps that true even if someone
  // pushes to the base branch mid-fan-out.
  const manifest = (deps.manifest ?? (() => readManifest(config.repoPath, base)))();
  // §21, and once per dispatch for the same reason: every member of a team is
  // held to ONE materialised copy of the rules, even if someone pushes to the
  // base branch mid-fan-out. The scratch dir is the dispatch's own run dir.
  const rules = (deps.rules ?? (() => materialiseRules(config.repoPath, base, join(runDir(runsDir, id), "rules"))))();
  const timeoutSec = dispatch.limits?.runSeconds ?? config.defaultTimeoutSec;
  const lead = leadRole(name);

  // The slots actually FREE, never the machine-wide max: a second dispatch that
  // bounded itself by `maxConcurrent` would launch a full machine's worth on top
  // of the first one's members. `RunStore.start()` is the real gate; this only
  // keeps the queue there short.
  const finished = fanOut(items, store.free(), (item, index) =>
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
      findPr,
      report,
      manifest,
      rules,
      index: deps.codegraph ?? ((worktree) => indexWorktree(worktree)),
      ...(deps.agentToken === undefined ? {} : { agentToken: deps.agentToken }),
      ...(deps.agentEnv === undefined ? {} : { agentEnv: deps.agentEnv }),
      ...(deps.repoFullName === undefined ? {} : { repoFullName: deps.repoFullName }),
      ...(deps.environment === undefined ? {} : { environment: deps.environment }),
      ...(deps.resolvers === undefined ? {} : { resolvers: deps.resolvers }),
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
  findPr: (repoPath: string, branch: string) => Promise<string | undefined>;
  report: (report: RunReport) => void;
  manifest: Promise<ManifestResult | undefined>;
  rules: Promise<RulesResult>;
  index: (worktree: string) => Promise<IndexedWorktree>;
  agentToken?: string;
  agentEnv?: Record<string, string>;
  repoFullName?: string;
  environment?: EnvironmentDeps;
  resolvers?: ResolverDeps;
}

async function runMember(args: MemberArgs): Promise<void> {
  const { config, dispatch, item, store, report } = args;
  const runsDir = config.runsDir;
  const dispatchId = dispatch.id;
  const runId = item.runId;
  const startedAt = new Date().toISOString();
  const branch = `run/${args.name}`;

  /** Refuse before a worktree is cut. Nothing about this run can be fixed by trying. */
  const refuse = (summary: string): void => {
    const failed: RunReport = { dispatchId, runId, status: "failed", summary: summary.slice(0, 500) };
    writeRunState(runsDir, { dispatchId, runId, state: "failed", startedAt, branch, report: failed });
    report(failed);
  };

  const pat = item.runToken || args.agentToken;
  if (!pat) {
    return refuse(
      "no run token in the claim and no KAIROKU_AGENT_TOKEN configured — the agent would have no credential",
    );
  }

  // §20.11 — the environment, in the order the ruling names. The manifest and
  // the secrets are settled BEFORE a worktree exists, because both can only
  // fail one way and a run that cannot be given its environment should not be
  // given a checkout either.
  const manifest = await args.manifest;
  if (manifest && !manifest.ok) return refuse(`the repo's environment cannot be read: ${manifest.error}`);

  // §21 Q25 — a repo that declares rules on a machine that cannot run them
  // fails the run CLOSED, naming ast-grep, exactly as a `{ref}` nobody here can
  // resolve does below. Settled before a worktree exists: a run that cannot be
  // held to the repo's rules should not be given a checkout either.
  const rules = await args.rules;
  if (!rules.ok) return refuse(rules.error);

  // Resolved here, on this machine, and held in memory only. The values join
  // the run's masking set before the first event can be written, which is why
  // this happens before `store.start` rather than inside the worktree.
  const delivered = (dispatch.env?.secrets ?? {}) as Record<string, DeliveredSecret>;
  const resolved = await resolveSecrets(delivered, args.resolvers);
  if (!resolved.ok) return refuse(`the run's environment could not be prepared: ${resolved.error}`);
  const secrets = resolved.values;

  const profileName = dispatch.env?.profile ?? "test";
  const portRange = parsePortRange(args.config.ports ?? DEFAULT_PORT_RANGE) ?? parsePortRange(DEFAULT_PORT_RANGE)!;
  const launchedAt = Date.parse(startedAt);
  let ports: Record<string, number> = {};
  let measure: RunMeasure | undefined;
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
      ...(Object.keys(ports).length === 0 ? {} : { ports }),
      ...(measure === undefined ? {} : { measure }),
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
    // The run's own credential AND every delivered value are masked out of both
    // logs (§20.11): a provider that echoes one back cannot leak it.
    secrets: [pat, ...Object.values(secrets)],
    onStarted: ({ worktree }) => {
      save("running", { worktree });
      // §20 addendum 6 — EVERY run says `running` once at launch. A dispatch
      // whose progress showed only in the beat's `runs[].state` would stay
      // `claimed` in the app and be re-claimable after the lease.
      report({ dispatchId, runId, status: "running", state: "running", role: args.lead });
    },
    execute: async (ctx) => {
      const cwd = ctx.worktree.path;

      const environment = await prepareEnvironment(
        {
          dispatchId,
          runId,
          worktree: cwd,
          profileName,
          secrets,
          perRun: { KAIROKU_PAT: pat },
          portRange,
          ...(args.config.envDir === undefined ? {} : { envDir: args.config.envDir }),
          ...(args.repoFullName === undefined ? {} : { repoFullName: args.repoFullName }),
          ...(manifest?.ok ? { manifest: manifest.manifest } : {}),
        },
        args.environment,
      );
      // Registered FIRST, before `ok` is read: a compose project that came up
      // before the init step failed must not outlive the run either.
      ctx.onTeardown(environment.teardown);
      // Recorded even on the failure path: a run that held ports and could not
      // start is exactly the one somebody has to read the json of afterwards.
      ports = environment.ports;
      save("running", { worktree: cwd });
      if (!environment.ok) return { ok: false, summary: environment.summary ?? "the run environment failed" };

      // `agentEnv` goes ON TOP of the profile's values, not under them. It
      // carries the app's own origin, and `inject` is repo-controlled: a
      // committed manifest that could set KAIROKU_URL would send the agent —
      // carrying KAIROKU_PAT, this run's credential — to an origin the repo
      // chose. The daemon's own facts about the app are not the repo's to set.
      // §21 item 2 — the index, AFTER the worktree exists and BEFORE the first
      // role launches, and only when the base branch's manifest opted in.
      // One index per worktree: CodeGraph will not share one across worktrees,
      // so this is paid per member, which is exactly what Q4 is measuring.
      const indexed =
        manifest?.ok && manifest.manifest.intelligence.includes("codegraph") ? await args.index(cwd) : {};
      // §23.4's rider — its OWN kind now that the app's enum accepts one. It was
      // `ok` only because a sixth kind would have been refused at the wire
      // (CLI PR #12); the text is unchanged.
      if (indexed.event) ctx.events.push("index", indexed.event);

      // §23.4 — one event per TRANSITION, before the status update it explains.
      // A stage re-entered after a fix round IS a transition; a second turn in
      // the stage the run is already in is not, and would draw a divider through
      // the middle of one piece of work.
      let stage: Stage | undefined;
      const enter = (next: Stage): void => {
        if (stage === next) return;
        stage = next;
        ctx.events.push("phase", next);
      };

      const env = childEnv({ ...environment.values, ...(args.agentEnv ?? {}) });
      const plan = qaPlan(cwd, {
        ...(manifest?.ok ? { manifest: manifest.manifest } : {}),
        ...(args.repoFullName === undefined ? {} : { key: args.repoFullName }),
      });
      const memberCtx: MemberContext = {
        item: { id: item.id, key: item.key, title: item.title, body: item.body },
        brief: dispatch.brief ?? "",
        worktree: cwd,
        cancelled: ctx.cancelled,
        qa: () => {
          enter("qa");
          return runQa(cwd, {
            plan,
            env,
            // Layer two. Bound only when the base branch declared rules, which
            // is what makes the gate automatic without a manifest entry.
            ...(rules.rules === undefined ? {} : { scan: () => scanRules(rules.rules as Rules, cwd, ["."]) }),
          });
        },
        runRole: async (role, prompt) => {
          enter(stageForRole(role));
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
            ...(rules.rules === undefined ? {} : { rules: rules.rules }),
            ...(indexed.codegraph === undefined ? {} : { codegraph: indexed.codegraph }),
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
      // §21 Q19, pushed HERE rather than beside the terminal report: the link
      // drains `store.list()`, which holds only RUNNING runs, so a line pushed
      // after this body returns would reach the local log and never the app.
      measure = { toolCalls: ctx.events.tools(), wallClockMs: Date.now() - launchedAt };
      ctx.events.push("ok", `run: ${measure.toolCalls} tool calls in ${(measure.wallClockMs / 1000).toFixed(1)}s`);
      // The terminal divider, pushed HERE for the reason the measure line above
      // is: the link drains `store.list()`, which holds only RUNNING runs, so a
      // phase pushed after this body returns would never leave the machine.
      enter(outcome.ok ? "done" : "failed");
      return { ok: outcome.ok, summary: outcome.summary };
    },
  });

  const ok = result.status === "idle";
  // Asked of the base checkout, not the worktree: the worktree is torn down by
  // the time a run is terminal, and the branch is what the forge knows.
  const prUrl = await args.findPr(config.repoPath, result.branch).catch(() => undefined);
  const counts = outcome.counts;
  const documentIds = readDocumentIds(outcome.report);

  // §23.4 — whatever the member said after the last drain: the closing divider
  // and §21's `run: n tool calls` measure line, both pushed in the run's final
  // moments. NOTHING ELSE CAN CARRY THEM. The link drains `store.list()`, which
  // holds only RUNNING runs, so a line pushed that late reaches the local log
  // and never the app unless the report it belongs to takes it. The record
  // outlives the run, so the drain still answers here.
  const trailing = store.drainEvents(runId);

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
    ...(trailing.length === 0 ? {} : { events: trailing }),
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
