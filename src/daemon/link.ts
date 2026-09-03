/**
 * RF-012 — the loop that links this daemon to the app.
 *
 * Two timers and one rule each:
 *
 *   HEARTBEAT, every 10 s WHILE ANY RUN IS ACTIVE and at the app's own cadence
 *   otherwise (grill Q6). It carries `meta`, one report per live run with that
 *   run's curated events, and any terminal report `update` could not deliver.
 *   CLAIM, every 5 s, but only while there is a free slot AND the last
 *   heartbeat succeeded — claiming into a link that is not working takes a
 *   dispatch off the queue that nothing will report on.
 *
 * `unauthorized` stops both, once, loudly. The listener stays up on purpose:
 * `kairoku doctor` has to be able to walk up to a daemon whose token the app
 * refused and be told exactly that, which it cannot do if the process exits.
 *
 * `beat()` and `poll()` are one turn each and return what the scheduler needs,
 * so the policy is testable without waiting out a real cadence.
 */

import {
  appClient,
  type AppClient,
  type AppResult,
  type CancelInstruction,
  type ClaimedDispatch,
  type RunOutcome,
  type RunReport,
} from "./app";
import type { Config } from "./config";
import { EVENTS_PER_REPORT_MAX } from "./events";
import { machineMeta } from "./models";
import {
  clearPendingReport,
  pendingReports,
  startDispatch,
  sweepRestarts,
  writeRunState,
} from "./dispatch";
import { productionProviders, type Provider, type ProviderName } from "./providers";
import type { RunStore } from "./runs";
import { originFullName } from "./worktree";

export const CLAIM_INTERVAL_MS = 5_000;
export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
/** Grill Q6 — the fast cadence while anything is running. */
export const ACTIVE_HEARTBEAT_MS = 10_000;
/** The app caps a beat's `runs` at 50. */
const MAX_RUNS_PER_BEAT = EVENTS_PER_REPORT_MAX;

export interface LinkStatus {
  /** An appUrl and a credential are both configured. */
  readonly linked: boolean;
  readonly appUrl?: string;
  readonly liveness?: string;
  readonly protocol?: string;
  readonly lastBeatAt?: string;
  readonly lastError?: string;
  /** Set once the app refuses the credential. Both timers are off. */
  readonly stopped?: "token-rejected";
  readonly runsInFlight: number;
  /** Terminal reports waiting for the app to accept them. */
  readonly pendingReports: number;
}

export interface Link {
  status(): LinkStatus;
  /** One heartbeat. Resolves with how long to wait before the next one. */
  beat(): Promise<number>;
  /** One claim, if the link and the capacity allow. True when work was taken. */
  poll(): Promise<boolean>;
  stop(): void;
}

export interface LinkOptions {
  readonly client?: AppClient;
  /** False in tests: no timers, the caller drives `beat()`/`poll()` by hand. */
  readonly autostart?: boolean;
  readonly log?: (line: string) => void;
  /**
   * The providers a claimed dispatch is run through. Absent in production,
   * where `startDispatch` builds the real registry; a test injects a fake here
   * so that no suite in this repo can reach a model.
   */
  readonly providers?: Record<ProviderName, Provider>;
}

export function startLink(store: RunStore, config: Config, options: LinkOptions = {}): Link {
  const log = options.log ?? ((line: string) => console.log(line));
  const client =
    options.client ??
    (config.appUrl && config.token ? appClient({ appUrl: config.appUrl, token: config.token }) : undefined);

  /** Terminal reports the app has not accepted, waiting for a beat to carry them. */
  const pending: RunReport[] = [];
  /** Reports already answered with a refusal; a second refusal is only logged. */
  const refusedOnce = new Set<string>();
  /** Dispatch ids this daemon is already running — the lease can re-issue one. */
  const active = new Set<string>();

  /**
   * ONE registry, used for both halves. What the beat advertises and what a
   * claimed dispatch is actually run through must be the same objects, or the
   * composer offers a model this machine will not drive.
   */
  const registry = options.providers ?? productionProviders(config);
  const models = Object.fromEntries(
    Object.entries(registry).map(([name, provider]) => [name, () => provider.models()]),
  );

  let stopped: "token-rejected" | undefined;
  let lastBeatOk = false;
  let lastBeatAt: string | undefined;
  let lastError: string | undefined;
  let liveness: string | undefined;
  let protocol: string | undefined;
  let heartbeatMs = DEFAULT_HEARTBEAT_MS;
  let backoffMs = 0;
  let beatTimer: ReturnType<typeof setTimeout> | undefined;
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  let booted = false;

  /**
   * §20.9 / grill Q21 — what this daemon has a checkout OF, asked of git once at
   * boot rather than configured twice. It is advertised in `meta.repos` so the
   * claim query can filter, and it is the left-hand side of the guard in
   * `startDispatch` for the race the filter cannot cover.
   */
  let repoFullName: string | undefined;
  const repoKnown: Promise<unknown> = client
    ? originFullName(config.repoPath).then((name) => {
        repoFullName = name;
        if (!name) {
          log(
            `app link: cannot read the origin remote of ${config.repoPath} — this machine advertises no repos and will be offered no work (§20.9)`,
          );
        }
      })
    : Promise.resolve();

  const status = (): LinkStatus => ({
    linked: client !== undefined,
    ...(client === undefined ? {} : { appUrl: client.appUrl }),
    ...(liveness === undefined ? {} : { liveness }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(lastBeatAt === undefined ? {} : { lastBeatAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(stopped === undefined ? {} : { stopped }),
    runsInFlight: store.capacity().running,
    pendingReports: pending.length,
  });

  function halt(error: string): void {
    stopped = "token-rejected";
    lastBeatOk = false;
    lastError = error;
    clearTimeout(beatTimer);
    clearTimeout(claimTimer);
    beatTimer = claimTimer = undefined;
    log(`app link: ${error} — the loop is stopped; fix the token and restart (kairoku setup --daemon)`);
  }

  /** True when the caller should give up on this result and stop everything. */
  function halted(result: AppResult<unknown>): boolean {
    if (result.ok || result.kind !== "unauthorized") return false;
    if (!stopped) halt(result.error);
    return true;
  }

  /**
   * RF-013 — on the first beat, whatever the last daemon left mid-flight is
   * reported failed, and whatever it could not deliver is queued again.
   * Reported, never replayed.
   */
  async function bootReports(): Promise<void> {
    if (booted) return;
    booted = true;
    for (const carried of pendingReports(config.runsDir)) pending.push(carried);
    for (const stranded of await sweepRestarts(config.runsDir)) {
      // A run whose own terminal report is already queued does not need a
      // second, contradictory one.
      if (pending.some((p) => p.runId === stranded.runId)) continue;
      pending.push({
        dispatchId: stranded.dispatchId,
        runId: stranded.runId,
        status: "failed",
        summary: "daemon restarted",
        artifacts: { branch: stranded.branch },
      });
    }
  }

  /** One entry per live run: what it is doing, and the lines it has waiting. */
  function liveReports(budget: number): RunReport[] {
    const out: RunReport[] = [];
    for (const run of store.list()) {
      if (out.length >= budget) break;
      const events = store.drainEvents(run.runId);
      out.push({
        dispatchId: run.dispatchId,
        runId: run.runId,
        ...(run.role === undefined ? {} : { role: run.role }),
        state: run.state,
        ...(events.length === 0 ? {} : { events }),
      });
    }
    return out;
  }

  async function beat(): Promise<number> {
    if (stopped) return 0;
    if (!client) return DEFAULT_HEARTBEAT_MS;
    await bootReports();
    // The FIRST beat must already advertise the repos, or the claim query has
    // nothing to filter on for one whole cadence.
    await repoKnown;

    const carried = pending.splice(0, MAX_RUNS_PER_BEAT);
    const live = liveReports(MAX_RUNS_PER_BEAT - carried.length);
    const sent = [...carried, ...live];

    const result = await client.heartbeat({
      meta: await machineMeta(config, {
        capacity: () => store.capacity(),
        repos: async () => (repoFullName ? [repoFullName] : []),
        models,
      }),
      ...(sent.length === 0 ? {} : { runs: sent }),
    });

    if (halted(result)) return 0;

    if (!result.ok) {
      // Nothing was delivered, so nothing is dropped: put the terminal reports
      // back at the front, in order, for the next attempt. The live entries are
      // regenerated next beat; their EVENTS are the loss, which is why the
      // local jsonl keeps everything.
      pending.unshift(...carried);
      lastBeatOk = false;
      lastError = result.error;
      backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      log(`app link: heartbeat failed (${result.error}); retrying in ${Math.round(backoffMs / 1000)}s`);
      return backoffMs;
    }

    lastBeatOk = true;
    lastError = undefined;
    backoffMs = 0;
    lastBeatAt = new Date().toISOString();
    liveness = result.body.liveness;
    protocol = result.body.protocol;
    heartbeatMs = result.body.heartbeatIntervalMs > 0 ? result.body.heartbeatIntervalMs : DEFAULT_HEARTBEAT_MS;

    settleOutcomes(sent, carried, result.body.runs ?? []);
    obey(result.body.cancel ?? []);

    // A 200 on a carried report is the app accepting it: it is off the disk now.
    for (const delivered of carried) clearPendingReport(config.runsDir, delivered.dispatchId, delivered.runId);

    // Grill Q6 — fast while anything is happening, the app's cadence otherwise.
    return store.capacity().running > 0 ? Math.min(ACTIVE_HEARTBEAT_MS, heartbeatMs) : heartbeatMs;
  }

  /**
   * A 200 ON THE BEAT IS NOT CONSENT FOR WHAT THE BEAT CARRIED.
   *
   * Pair each outcome with the report it answers BY `runId` when the app sends
   * one, and only fall back to position when it does not. Index pairing alone
   * is how a refusal gets attributed to the wrong run — and the app is free to
   * reorder or to answer a subset. A length mismatch is logged rather than
   * silently mapped.
   */
  function settleOutcomes(sent: RunReport[], carried: RunReport[], outcomes: RunOutcome[]): void {
    if (outcomes.length !== sent.length) {
      log(`app link: the app answered ${outcomes.length} of ${sent.length} reports — pairing by run id where it can`);
    }
    const byRunId = new Map(sent.map((report) => [report.runId, report]));
    outcomes.forEach((outcome, i) => {
      if (outcome?.ok !== false) return;
      const answered = (outcome.runId && byRunId.get(outcome.runId)) || sent[i];
      // Only a TERMINAL report can be refused into a stuck row; a live entry
      // the app disliked is next beat's problem.
      if (!answered || !carried.includes(answered)) {
        if (answered) log(`app link: the app refused a progress report for ${answered.runId} — ${reasonOf(outcome)}`);
        return;
      }
      refused(answered, reasonOf(outcome));
    });
  }

  const reasonOf = (outcome: RunOutcome): string =>
    [outcome.reason, ...(outcome.issues ?? [])].filter(Boolean).join(": ") || "no reason given";

  /** Grill Q5 — the app can stop a whole dispatch or one member of it. */
  function obey(cancels: CancelInstruction[]): void {
    for (const instruction of cancels) {
      if (instruction.runId) {
        if (store.cancel(instruction.runId)) log(`app link: cancelling run ${instruction.runId}`);
      } else {
        const stoppedCount = store.cancelDispatch(instruction.dispatchId);
        if (stoppedCount > 0) log(`app link: cancelling ${stoppedCount} run(s) of ${instruction.dispatchId}`);
      }
    }
  }

  async function poll(): Promise<boolean> {
    if (stopped || !client) return false;
    // Never claim into a link that is not working, and never past capacity.
    if (!lastBeatOk) return false;
    if (store.free() === 0) return false;

    const result = await client.claim();
    if (halted(result)) return false;
    if (!result.ok) {
      lastError = result.error;
      return false;
    }

    const dispatch = result.body.dispatch;
    if (!dispatch) return false;
    if (active.has(dispatch.id)) {
      // The lease re-issued a row we already hold. Running it twice is worse
      // than any stuck row (§20.7); say nothing new and carry on.
      log(`app link: ignoring a second claim of ${dispatch.id} — already running here`);
      return false;
    }
    active.add(dispatch.id);
    void run(dispatch);
    return true;
  }

  async function run(dispatch: ClaimedDispatch): Promise<void> {
    await repoKnown;
    const started = startDispatch(store, config, dispatch, {
      ...(config.agentToken === undefined ? {} : { agentToken: config.agentToken }),
      ...(repoFullName === undefined ? {} : { repoFullName }),
      ...(client === undefined ? {} : { agentEnv: { KAIROKU_URL: client.appUrl } }),
      providers: registry,
      report: (payload) => void report(payload),
    });
    try {
      await started.finished;
    } catch (err) {
      log(`app link: the daemon lost ${dispatch.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    active.delete(dispatch.id);
  }

  /**
   * One report, delivered now if the app will take it.
   *
   * A `server`/`network` failure is the LINK's problem: the report is queued and
   * the next beat carries it — and it is already on disk, so a restart carries
   * it too. A `rejected` answer is the RUN's problem — the app understood and
   * said no — so it is answered once and never retried into the same refusal.
   */
  async function report(update: RunReport): Promise<void> {
    if (stopped || !client) return;
    const result = await client.update(update);
    if (result.ok) {
      clearPendingReport(config.runsDir, update.dispatchId, update.runId);
      return;
    }
    if (halted(result)) return;
    if (result.kind === "rejected") {
      return refused(update, [result.error, ...(result.issues ?? [])].filter(Boolean).join(": "));
    }
    lastError = result.error;
    if (update.status === "done" || update.status === "failed") pending.push(update);
  }

  /**
   * The app understood a report and said no. It reads the same on both paths —
   * a direct `update` 4xx and an `{ok:false}` entry in a beat's `runs[]` — so it
   * is handled in one place.
   *
   * A REFUSED TERMINAL REPORT LEAVES THE APP ROW `running` while this daemon
   * has stopped working on it. One FOLLOW-UP `failed` report, carrying the
   * refusal reason, settles the row; a `failed` needs no counts, so it cannot be
   * refused for the reason the first one was. The refused report itself is never
   * retried, and a refused follow-up is only logged — there is nothing left to
   * say and a third attempt is a loop.
   */
  function refused(update: RunReport, reason: string): void {
    // `doctor` reads this: it must name the run it came from (O-1 verifier 3).
    lastError = `run ${update.runId} of ${update.dispatchId}: ${reason}`;
    log(`app link: the app refused the report for run ${update.runId} — ${reason}`);
    clearPendingReport(config.runsDir, update.dispatchId, update.runId);
    writeRunState(config.runsDir, {
      dispatchId: update.dispatchId,
      runId: update.runId,
      state: "failed",
      startedAt: new Date().toISOString(),
      branch: update.artifacts?.branch ?? `run/${update.dispatchId}`,
    });

    if (refusedOnce.has(update.runId) || update.status === undefined) return;
    refusedOnce.add(update.runId);
    void report({
      dispatchId: update.dispatchId,
      runId: update.runId,
      status: "failed",
      summary: `the app refused this run's report: ${reason}`.slice(0, 500),
    });
  }

  // ------------------------------------------------------------- the timers

  function scheduleBeat(delay: number): void {
    if (stopped) return;
    beatTimer = setTimeout(() => void beat().then(scheduleBeat), delay);
    beatTimer.unref?.();
  }

  function scheduleClaim(): void {
    if (stopped) return;
    claimTimer = setTimeout(() => void poll().finally(scheduleClaim), CLAIM_INTERVAL_MS);
    claimTimer.unref?.();
  }

  const link: Link = {
    status,
    beat,
    poll,
    stop() {
      clearTimeout(beatTimer);
      clearTimeout(claimTimer);
      beatTimer = claimTimer = undefined;
    },
  };

  if (options.autostart !== false) {
    if (!client) {
      log(
        config.appUrl
          ? "app link: no KAIROKU_DAEMON_TOKEN — not linking (kairoku setup --daemon)"
          : "app link: no appUrl in config.json — not linking (kairoku setup --daemon)",
      );
    } else {
      log(`app link: ${client.appUrl}`);
      void beat().then(scheduleBeat);
      scheduleClaim();
    }
  }
  return link;
}
