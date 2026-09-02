/**
 * RF-011 — the Kairoku app client. THE ONLY OUTBOUND MODULE IN THE DAEMON.
 *
 * `constraints.test.ts` asserts that: no other production module may call
 * `fetch`, and this one may build only the three paths in `DAEMON_ROUTES`
 * under the configured `appUrl`. That is the mechanical form of §20.3 — the
 * daemon dials out, to one place, for three things.
 *
 * Every answer is turned into a TAG rather than handed on as a status code,
 * because the loop's whole policy is a function of which of four things
 * happened, and a caller reading numbers would eventually get one wrong:
 *
 *   unauthorized — the app refuses this credential. STOP; a retry cannot help.
 *   rejected     — the app understood and said no (404 not held, 422 invalid).
 *                  The run is wrong, not the link.
 *   server       — the app is up and unwell. Back off.
 *   network      — nothing answered. Back off.
 *
 * The token is sent and never stored in a result, a message or an event.
 */

export const PROTOCOL_VERSION = "1";

/** The whole outbound surface. Kept as literals so the constraint can read it. */
export const DAEMON_ROUTES = [
  "/api/daemon/heartbeat",
  "/api/daemon/claim",
  "/api/daemon/update",
] as const;

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- wire shapes
//
// Vendored from the app at `a986e23b`: `src/lib/orchestration/dispatches.ts`
// and the three route handlers. Fields protocol v1 adds are optional here, so
// today's app and tomorrow's both parse.

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
  readonly jsonl?: string;
}

export interface HeartbeatMeta {
  readonly host: string;
  readonly version: string;
  readonly capacity: { running: number; max: number };
}

export interface DispatchUpdate {
  readonly dispatchId: string;
  readonly status: "running" | "done" | "failed";
  readonly summary?: string;
  readonly artifacts?: RunArtifacts;
  readonly counts?: SuiteCounts;
}

export interface HeartbeatBody {
  readonly meta: HeartbeatMeta;
  /** The app caps this at 50; the loop never sends more. */
  readonly runs?: DispatchUpdate[];
}

export interface HeartbeatResponse {
  readonly daemon: { id: string; name: string };
  readonly liveness: "online" | "stale" | "offline";
  readonly heartbeatIntervalMs: number;
  readonly protocol?: string;
  /** One outcome per piggybacked report, in the order they were sent. */
  readonly runs: Array<{ ok: boolean; id?: string; status?: string; reason?: string; issues?: string[] }>;
}

/** What the app hands over at claim. Only the first six fields exist today. */
export interface ClaimedDispatch {
  readonly id: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly taskType: string;
  readonly brief: string;
  readonly createdAt: string;
  readonly repo?: { provider?: string; fullName?: string; defaultBranch?: string };
  readonly items?: Array<{ id?: string; runToken?: string }>;
  /** Protocol v1 may carry the run token at the top level instead. */
  readonly runToken?: string;
}

export interface ClaimResponse {
  readonly dispatch: ClaimedDispatch | null;
}

export interface UpdateResponse {
  readonly ok: boolean;
  readonly id?: string;
  readonly status?: string;
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
  update(body: DispatchUpdate): Promise<AppResult<UpdateResponse>>;
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
  };
}

/** The run token for a dispatch, wherever this protocol version puts it. */
export function runTokenOf(dispatch: ClaimedDispatch): string | undefined {
  return dispatch.items?.[0]?.runToken ?? dispatch.runToken ?? undefined;
}

function readIssues(parsed: unknown): string[] | undefined {
  const issues = (parsed as { issues?: unknown })?.issues;
  return Array.isArray(issues) ? issues.filter((i): i is string => typeof i === "string") : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
