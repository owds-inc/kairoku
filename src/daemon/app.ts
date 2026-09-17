/**
 * RF-011 — the Kairoku app client. THE ONLY OUTBOUND MODULE IN THE DAEMON.
 *
 * `constraints.test.ts` asserts that: no other production module may call
 * `fetch`, and this one may build only the paths in `DAEMON_ROUTES`
 * under the configured `appUrl`. That is the mechanical form of §20.3 — the
 * daemon dials out, to one place, for the pinned routes (heartbeat/claim/update
 * plus drain acknowledgement).
 *
 * Every answer is turned into a TAG rather than handed on as a status code,
 * because the loop's whole policy is a function of which of four things
 * happened, and a caller reading numbers would eventually get one wrong:
 *
 *   unauthorized — the app refuses this credential. STOP; a retry cannot help.
 *   rejected     — the app understood and said no (404 not held, 409 already
 *                  terminal, 422 invalid). The run is wrong, not the link.
 *   server       — the app is up and unwell. Back off.
 *   network      — nothing answered. Back off.
 *
 * The token is sent and never stored in a result, a message or an event.
 */

import type { EventKind } from "./events";

export const PROTOCOL_VERSION = "1";

/**
 * Catalog names only. Copying them onto a heartbeat is not support.
 * Protocol stays v1. `DAEMON_ROUTES` has no delivery admit path, so this
 * process advertises nothing. Format 2 is not a path this build implements.
 */
export const RELEASE_DELIVERY_CAPABILITY = "release-delivery-v1";
export const RELEASE_DELIVERY_CAPABILITY_V2 = "release-delivery-v2";
export const DELIVERY_CAPABILITIES = [
  RELEASE_DELIVERY_CAPABILITY,
  RELEASE_DELIVERY_CAPABILITY_V2,
] as const;
export type DeliveryCapability = (typeof DELIVERY_CAPABILITIES)[number];

/**
 * A process may advertise a capability only when it can perform the matching
 * admit. Manifest 1 is `release-delivery-v1`. Manifest 2 is not implemented
 * here and is not advertised from a format-1 path.
 */
export type DeliveryPath = {
  readonly admit: (body: unknown) => Promise<unknown>;
  readonly manifestVersion: 1;
};

export function advertisedDeliveryCapabilities(
  path: DeliveryPath | null,
): readonly DeliveryCapability[] {
  if (!path || path.manifestVersion !== 1) return [];
  return [RELEASE_DELIVERY_CAPABILITY];
}

/**
 * This process cannot admit delivery. The routes below are the whole
 * outbound surface; none of them is delivery admit. The supported admit path
 * is kairokud `deliver`, which this binary does not call.
 */
export function supportedDeliveryPath(): DeliveryPath | null {
  return null;
}

/** The whole outbound surface. Kept as literals so the constraint can read it. */
export const DAEMON_ROUTES = [
  "/api/daemon/heartbeat",
  "/api/daemon/claim",
  "/api/daemon/update",
  "/api/daemon/drain",
] as const;

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- wire shapes
//
// Protocol v1, vendored from the app at `eab363ea`:
// `src/lib/comms/protocol/index.ts` and the three route handlers. Every field
// the app treats as optional is optional here too, so a daemon one version
// ahead of its app and one version behind both parse.
//
// FL01-E ADDED `ClaimedDispatch.sessionVisibility` BY HAND, not by a full
// re-vendor at a newer SHA — this file still otherwise reflects `eab363ea`
// and, notably, predates protocol 2 entirely (no `claimId`/`processInstanceId`
// here at all). Recording that honestly rather than bumping the SHA comment:
// bumping it would claim a full re-sync this change did not do. The field is
// additive and optional on the app's own wire (no protocol-version bump
// there either), so this keeps the same "one version ahead, one version
// behind, both parse" property the paragraph above already promises — this
// CLI simply has nothing that reads the field, the same as it has nothing
// that reads `claimId`.

export interface SuiteCounts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly errors: number;
}

export interface RunArtifacts {
  readonly prUrl?: string;
  readonly branch?: string;
  readonly documentIds?: string[];
}

/** The word the Floor prints while a run is still happening. Not its status. */
export type RunState = "starting" | "running" | "needs_input" | "finishing";

/**
 * One curated line on the wire.
 *
 * `kind` is the DAEMON'S OWN vocabulary (`events.ts`), not a second hand-copy of
 * the app's enum. A `type` import erases, so this module still pulls nothing at
 * runtime — and §23.4's three new kinds could not reach the app through a union
 * that was widened in one file and forgotten in the other.
 */
export interface RunEvent {
  readonly seq: number;
  readonly ts: string;
  readonly kind: EventKind;
  readonly text: string;
}

export interface DaemonMeta {
  readonly protocol: string;
  readonly host: string;
  readonly version: string;
  readonly capacity: { running: number; max: number };
  /** `owner/repo` for every checkout this machine holds. The claim filter reads it. */
  readonly repos?: string[];
  /** provider → the models it can actually drive, as the tool itself reported them. */
  readonly providers?: Record<string, string[]>;
  readonly recipes?: string[];
}

/**
 * Which manifest supplied the QA test command (wire `RunReport.provenance`).
 * Values match kairokud `Provenance` serde renames exactly — no fourth variant.
 */
export type RunProvenance = "kairoku.json" | "package.json" | "none";

/**
 * One report about one RUN. `status` is optional on a beat and required on
 * `/update`: a beat says what is happening, an update says what happened.
 */
export interface RunReport {
  readonly dispatchId: string;
  readonly runId: string;
  readonly role?: string;
  readonly state?: RunState;
  readonly status?: "running" | "done" | "failed";
  readonly summary?: string;
  readonly artifacts?: RunArtifacts;
  readonly counts?: SuiteCounts;
  readonly events?: RunEvent[];
  /** Present once QA ran; omitted when the recipe never enters the QA gate. */
  readonly provenance?: RunProvenance;
}

export interface HeartbeatBody {
  readonly meta: DaemonMeta;
  /** The app caps this at 50; the loop never sends more. */
  readonly runs?: RunReport[];
  /**
   * Optional closed set copied from the app heartbeat schema. Absent means
   * none. Production heartbeats do not populate this field.
   */
  readonly deliveryCapabilities?: readonly DeliveryCapability[];
}

/** One thing the app wants stopped. `runId` absent means the whole dispatch. */
export interface CancelInstruction {
  readonly dispatchId: string;
  readonly runId?: string;
}

export interface RunOutcome {
  readonly ok: boolean;
  readonly id?: string;
  readonly runId?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly issues?: string[];
}

export interface HeartbeatResponse {
  readonly daemon: { id: string; name: string };
  readonly liveness: "online" | "stale" | "offline";
  readonly heartbeatIntervalMs: number;
  readonly protocol?: string;
  readonly cancel?: CancelInstruction[];
  /** One outcome per piggybacked report. Paired by `runId` where the app sends one. */
  readonly runs?: RunOutcome[];
}

/** One item of a claim: the plan item, the run row it becomes, and that run's credential. */
export interface ClaimItem {
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  /** The six-section body written at plan time. THIS is the brief (invariant 3). */
  readonly body: string;
  readonly runId: string;
  readonly runToken: string;
}

export interface ClaimTeam {
  readonly recipe?: string;
  readonly roles?: Record<string, { provider?: string; model?: string; effort?: string }>;
}

/** What the app hands over at claim (protocol v1). */
export interface ClaimedDispatch {
  readonly id: string;
  readonly taskType: string;
  readonly brief: string;
  readonly project?: { id: string; slug: string };
  readonly target?: { kind: string; id: string; title: string };
  readonly repo?: {
    provider?: string;
    fullName?: string;
    defaultBranch?: string;
    defaultBranchSource?: string;
  } | null;
  readonly team?: ClaimTeam | null;
  readonly items?: ClaimItem[];
  /**
   * The environment the run builds in: the profile's name and the values the
   * app holds for it (§20.11). A REFERENCE ARRIVES AS `{ ref }`, unresolved —
   * the app holds no vault credential, so the machine dials its own.
   */
  readonly env?: { profile?: string; secrets?: Record<string, string | { ref: string }> };
  readonly limits?: { runSeconds?: number | null };
  /**
   * FL01-E — the approval's session-observation policy. Additive and
   * optional: an app ahead of this CLI always sends it explicitly (the
   * column it comes from is `NOT NULL DEFAULT 'private'`); an app at or
   * before `eab363ea` never sends it at all. Both read as "private" to
   * anything that might one day check this field — this CLI does not yet
   * check it, so today the field is carried for provenance-parity only, the
   * same as `taskType`'s literal union is kept as a plain `string` here
   * rather than re-narrowed: mirroring the SHAPE, not re-deriving the app's
   * enforcement.
   */
  readonly sessionVisibility?: "private" | "project";
}

export interface ClaimResponse {
  readonly dispatch: ClaimedDispatch | null;
}

export interface UpdateResponse {
  readonly ok: boolean;
  readonly id?: string;
  readonly runId?: string;
  readonly status?: string;
}

/** Cloud drain acknowledgement (F04/F08). Daemon cannot reactivate via this route. */
export interface DrainResponse {
  readonly ok?: boolean;
  readonly admissionMode?: "pending" | "active" | "draining" | "disabled";
}

// -------------------------------------------------------------------- results

export type AppErrorKind = "unauthorized" | "rejected" | "server" | "network";

export type AppResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly kind: AppErrorKind;
      readonly error: string;
      readonly issues?: string[];
    };

export interface AppClient {
  readonly appUrl: string;
  heartbeat(body: HeartbeatBody): Promise<AppResult<HeartbeatResponse>>;
  claim(): Promise<AppResult<ClaimResponse>>;
  update(body: RunReport): Promise<AppResult<UpdateResponse>>;
  /** Ask the app to latch cloud admission to draining. */
  drain(): Promise<AppResult<DrainResponse>>;
}

export interface AppClientOptions {
  readonly appUrl: string;
  readonly token: string;
  /** Test seam, and the seam `kairoku doctor` reaches the app through. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export function appClient(options: AppClientOptions): AppClient {
  const appUrl = options.appUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(route: (typeof DAEMON_ROUTES)[number], body?: unknown): Promise<AppResult<T>> {
    let response: Response;
    try {
      response = await doFetch(`${appUrl}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout and a refused connection are the same fact to the caller:
      // nothing answered, so back off and try again.
      return { ok: false, status: 0, kind: "network", error: `${appUrl} did not answer: ${message(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (response.ok) return { ok: true, status: response.status, body: parsed as T };

    const issues = readIssues(parsed);
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        kind: "unauthorized",
        // Never the token, never a prefix of it: the message is read aloud in
        // `doctor` output and pasted into issues.
        error: `token not accepted by ${appUrl}`,
      };
    }
    return {
      ok: false,
      status: response.status,
      kind: response.status >= 500 ? "server" : "rejected",
      error: `${appUrl}${route} answered ${response.status}${issues ? `: ${issues.join("; ")}` : ""}`,
      ...(issues === undefined ? {} : { issues }),
    };
  }

  return {
    appUrl,
    heartbeat: (body) => post<HeartbeatResponse>(DAEMON_ROUTES[0], body),
    claim: () => post<ClaimResponse>(DAEMON_ROUTES[1]),
    update: (body) => post<UpdateResponse>(DAEMON_ROUTES[2], body),
    drain: () => post<DrainResponse>(DAEMON_ROUTES[3], { mode: "draining" }),
  };
}

function readIssues(parsed: unknown): string[] | undefined {
  const issues = (parsed as { issues?: unknown })?.issues;
  return Array.isArray(issues) ? issues.filter((i): i is string => typeof i === "string") : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
