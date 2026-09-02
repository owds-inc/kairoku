/**
 * RF-012 — the loop that links this daemon to the app.
 *
 * Two timers and one rule each:
 *
 *   HEARTBEAT, at whatever cadence the last response asked for (30 s by
 *   default). It carries `meta` and any report `update` could not deliver.
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

import { hostname } from "node:os";
import { version } from "../../package.json";
import {
  appClient,
  type AppClient,
  type AppResult,
  type ClaimedDispatch,
  type DispatchUpdate,
} from "./app";
import type { Config } from "./config";
import { startDispatch, sweepRestarts, writeRunState, type DispatchReport } from "./dispatch";
import type { RunStore } from "./runs";
import { originFullName } from "./worktree";

export const CLAIM_INTERVAL_MS = 5_000;
export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 300_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;
/** The app caps a heartbeat's piggyback at 50 reports. */
const MAX_PIGGYBACK = 50;

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
  /** Reports waiting for a heartbeat to carry them. */
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
}

export function startLink(store: RunStore, config: Config, options: LinkOptions = {}): Link {
  const log = options.log ?? ((line: string) => console.log(line));
  const client =
    options.client ??
    (config.appUrl && config.token ? appClient({ appUrl: config.appUrl, token: config.token }) : undefined);

  /** Reports `update` could not deliver, waiting for a heartbeat to carry them. */
  const pending: DispatchUpdate[] = [];
  /** Dispatch ids this daemon is already running — the lease can re-issue one. */
  const active = new Set<string>();

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
   * §20.9 — what this daemon has a checkout OF, asked of git once at boot
   * rather than configured twice. Unreadable is warned about here and treated
   * as a mismatch by `startDispatch`, so a claim naming a repo is refused
   * rather than run against the wrong code.
   */
  let repoFullName: string | undefined;
  const repoKnown: Promise<unknown> = client
    ? originFullName(config.repoPath).then((name) => {
        repoFullName = name;
        if (!name) {
          log(
            `app link: cannot read the origin remote of ${config.repoPath} — any dispatch that names a repo will be refused (§20.9)`,
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
   * reported failed. Reported, never replayed.
   */
  function bootReports(): void {
    if (booted) return;
    booted = true;
    for (const stranded of sweepRestarts(config.runsDir)) {
      pending.push({
        dispatchId: stranded.dispatchId,
        status: "failed",
        summary: "daemon restarted",
        artifacts: { branch: stranded.branch },
      });
    }
  }

  async function beat(): Promise<number> {
    if (stopped) return 0;
    if (!client) return DEFAULT_HEARTBEAT_MS;
    bootReports();

    const carried = pending.splice(0, MAX_PIGGYBACK);
    const result = await client.heartbeat({
      meta: { host: hostname(), version, capacity: store.capacity() },
      ...(carried.length === 0 ? {} : { runs: carried }),
    });

    if (halted(result)) return 0;

    if (!result.ok) {
      // Nothing was delivered, so nothing is dropped: put the reports back at
      // the front, in order, for the next attempt.
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

    // One outcome per carried report, in the order they were sent. A `false`
    // one is the app refusing that run's report, and is answered exactly as the
    // direct path answers a 422 — never dropped because the beat itself was 200.
    (result.body.runs ?? []).forEach((outcome, i) => {
      const carriedUpdate = carried[i];
      if (!carriedUpdate || outcome?.ok !== false) return;
      refused(carriedUpdate, [outcome.reason, ...(outcome.issues ?? [])].filter(Boolean).join(": "));
    });
    return heartbeatMs;
  }

  async function poll(): Promise<boolean> {
    if (stopped || !client) return false;
    // Never claim into a link that is not working, and never past capacity.
    if (!lastBeatOk) return false;
    const { running, max } = store.capacity();
    if (running >= max) return false;

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
      onRunning: () => void report({ dispatchId: dispatch.id, status: "running" }),
    });
    let final: DispatchReport;
    try {
      final = await started.finished;
    } catch (err) {
      final = {
        dispatchId: dispatch.id,
        status: "failed",
        summary: `the daemon lost the run: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: {},
      };
    }
    active.delete(dispatch.id);
    await report({
      dispatchId: final.dispatchId,
      status: final.status,
      summary: final.summary,
      artifacts: final.artifacts,
      ...(final.counts === undefined ? {} : { counts: final.counts }),
    });
  }

  /**
   * One report, delivered now if the app will take it.
   *
   * A `server`/`network` failure is the LINK's problem: the report is queued
   * and the next heartbeat carries it. A `rejected` answer is the RUN's problem
   * — the app understood and said no — so it is logged and the run marked
   * failed locally with the app's own issues, never retried into the same 422.
   */
  async function report(update: DispatchUpdate): Promise<void> {
    if (stopped || !client) return;
    const result = await client.update(update);
    if (result.ok || halted(result)) return;

    if (result.kind === "rejected") return refused(update, result.error);
    lastError = result.error;
    pending.push(update);
  }

  /**
   * The app understood a report and said no. It reads the same on both paths —
   * the direct `update` 422 and an `{ok:false}` entry in a heartbeat's `runs[]`
   * — so it is handled in one place: a refusal carried back by the beat that
   * was only ever discarded is a run stuck `running` in the app with no record
   * anywhere of why.
   */
  function refused(update: DispatchUpdate, reason: string): void {
    lastError = reason;
    log(`app link: the app refused the report for ${update.dispatchId} — ${reason}`);
    writeRunState(config.runsDir, {
      dispatchId: update.dispatchId,
      state: "failed",
      startedAt: new Date().toISOString(),
      branch: update.artifacts?.branch ?? `run/${update.dispatchId}`,
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
