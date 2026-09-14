/**
 * Cross-device cloud enrollment through the resolved Rust daemon (F03).
 *
 * Flow: request → poll (private progress) → protected stdin token write →
 * `kairokud link acknowledge` → heartbeat identity proof. Credentials never
 * appear in argv, printed lines, or the returned identity.
 */

import { join } from "node:path";
import { hostname } from "node:os";
import type { Io } from "./io";
import type { Installation } from "./runtime";
import { kairokuHome, normaliseAppUrl } from "../daemon/config";

export const ENROLLMENT_PROGRESS_FILE = "enrollment-progress.json";
export const KAIROKUD_TOKEN_SETTING = "kairoku.token";

/** Private on-disk poll progress (mode 0600). Secrets cleared after terminal ack. */
export type EnrollmentProgress = {
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  /** Present only while polling; overwritten empty after terminal acknowledgement. */
  pollSecret?: string;
  backendUrl: string;
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  /** Non-secret receipt fields retained after activation. */
  daemonId?: string;
  ownerId?: string;
  state?: string;
};

export type EnrollmentIdentity = { daemonId: string; ownerId: string };

export class EnrollmentIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentIncompleteError";
  }
}

type PollApproved = {
  state: "approved";
  daemonId: string;
  token: string;
  ownerId: string;
  installationId: string;
};

type PollState =
  | { state: "pending" }
  | PollApproved
  | { state: "denied" | "cancelled" | "expired" | "not_found" }
  | { state: "activated"; daemonId: string; ownerId: string; installationId: string }
  | { state: "rate_limited"; retryAfterSeconds?: number };

type HeartbeatProof = {
  daemonId?: string;
  installationId?: string;
  ownerId?: string;
  liveness?: string;
};

function progressPath(io: Io, installation: Installation): string {
  // Prefer the Rust data root when present; fall back to CLI home for tests.
  const root = installation.dataRoot || join(kairokuHome(io.home), "data");
  return join(root, ENROLLMENT_PROGRESS_FILE);
}

export function loadEnrollmentProgress(io: Io, installation: Installation): EnrollmentProgress | null {
  const path = progressPath(io, installation);
  const raw = io.readFile(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as EnrollmentProgress;
    if (parsed.schemaVersion !== 1) return null;
    if (parsed.installationId !== installation.installationId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveEnrollmentProgress(
  io: Io,
  installation: Installation,
  progress: EnrollmentProgress,
): void {
  const path = progressPath(io, installation);
  io.writeFile(path, `${JSON.stringify(progress, null, 2)}\n`, 0o600);
}

/** Overwrite private progress: drop pollSecret without deleting the file. */
export function clearEnrollmentSecrets(io: Io, installation: Installation, progress: EnrollmentProgress): void {
  const cleaned: EnrollmentProgress = {
    schemaVersion: 1,
    installationId: progress.installationId,
    requestId: progress.requestId,
    backendUrl: progress.backendUrl,
    ...(progress.daemonId ? { daemonId: progress.daemonId } : {}),
    ...(progress.ownerId ? { ownerId: progress.ownerId } : {}),
    ...(progress.state ? { state: progress.state } : {}),
    ...(progress.userCode ? { userCode: progress.userCode } : {}),
    ...(progress.verificationUrl ? { verificationUrl: progress.verificationUrl } : {}),
  };
  saveEnrollmentProgress(io, installation, cleaned);
}

/**
 * Enrollment origin must be HTTPS outside explicitly configured loopback tests.
 */
export function assertEnrollmentOrigin(backendUrl: string): string {
  const url = new URL(normaliseAppUrl(backendUrl));
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && loopback) return url.origin;
  throw new EnrollmentIncompleteError(
    `enrollment backend must be HTTPS (or loopback HTTP for local tests); got ${url.protocol}//${host}`,
  );
}

async function postJson(
  io: Io,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function createOrResumeRequest(
  io: Io,
  installation: Installation,
  backendUrl: string,
  existing: EnrollmentProgress | null,
): Promise<EnrollmentProgress> {
  if (existing?.requestId && existing.pollSecret && existing.backendUrl === backendUrl) {
    return existing;
  }
  const { status, json } = await postJson(io, `${backendUrl}/api/daemon/enrollment/request`, {
    installationId: installation.installationId,
    name: io.env.HOSTNAME ?? hostname() ?? "machine",
    os: io.platform,
    arch: io.arch,
    profile: installation.profile,
  });
  if (status !== 200 && status !== 201) {
    throw new EnrollmentIncompleteError(`enrollment request failed (HTTP ${status})`);
  }
  const body = json as {
    requestId?: string;
    pollSecret?: string;
    userCode?: string;
    verificationUrl?: string;
    expiresAt?: string;
    intervalSeconds?: number;
  };
  if (!body.requestId || !body.pollSecret) {
    throw new EnrollmentIncompleteError("enrollment request response missing requestId/pollSecret");
  }
  const progress: EnrollmentProgress = {
    schemaVersion: 1,
    installationId: installation.installationId,
    requestId: body.requestId,
    pollSecret: body.pollSecret,
    backendUrl,
    ...(body.userCode ? { userCode: body.userCode } : {}),
    ...(body.verificationUrl ? { verificationUrl: body.verificationUrl } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    intervalSeconds: body.intervalSeconds ?? 5,
    state: "pending",
  };
  saveEnrollmentProgress(io, installation, progress);
  return progress;
}

async function pollOnce(io: Io, progress: EnrollmentProgress): Promise<PollState> {
  const { status, json } = await postJson(
    io,
    `${progress.backendUrl}/api/daemon/enrollment/poll`,
    { requestId: progress.requestId },
    { authorization: `Bearer ${progress.pollSecret}` },
  );
  if (status === 429) {
    const retry = (json as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 5;
    return { state: "rate_limited", retryAfterSeconds: retry };
  }
  if (status === 404) return { state: "not_found" };
  if (!json || typeof json !== "object") {
    throw new EnrollmentIncompleteError(`enrollment poll returned unexpected body (HTTP ${status})`);
  }
  return json as PollState;
}

function sleep(ms: number, io: Io): Promise<void> {
  // Tests inject `io.env.KAIROKU_ENROLLMENT_POLL_MS` to skip real waits.
  const override = io.env.KAIROKU_ENROLLMENT_POLL_MS;
  const wait = override !== undefined ? Number(override) : ms;
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(wait) ? wait : ms));
}

async function waitForApproval(
  io: Io,
  installation: Installation,
  progress: EnrollmentProgress,
  opts: { maxPolls?: number } = {},
): Promise<PollApproved> {
  const maxPolls = opts.maxPolls ?? 120;
  let current = progress;
  for (let i = 0; i < maxPolls; i++) {
    const result = await pollOnce(io, current);
    if (result.state === "approved") {
      if (result.installationId !== installation.installationId) {
        throw new EnrollmentIncompleteError("approved enrollment installationId mismatch");
      }
      return result;
    }
    if (result.state === "activated") {
      // Already activated — no token redelivery; treat as incomplete without credential.
      throw new EnrollmentIncompleteError(
        "enrollment already activated; restart enrollment with a fresh request if the token was lost",
      );
    }
    if (result.state === "denied" || result.state === "cancelled" || result.state === "expired" || result.state === "not_found") {
      current = { ...current, state: result.state };
      saveEnrollmentProgress(io, installation, { ...current, pollSecret: current.pollSecret });
      throw new EnrollmentIncompleteError(`enrollment ${result.state}`);
    }
    const intervalSec =
      result.state === "rate_limited"
        ? (result.retryAfterSeconds ?? current.intervalSeconds ?? 5)
        : (current.intervalSeconds ?? 5);
    if (current.userCode && i === 0) {
      io.out(`   … waiting for approval — code ${current.userCode}`);
      if (current.verificationUrl) io.out(`     ${current.verificationUrl}`);
    }
    await sleep(intervalSec * 1000, io);
  }
  throw new EnrollmentIncompleteError("enrollment poll timed out before approval");
}

async function writeRustToken(io: Io, token: string): Promise<void> {
  const bin = io.which("kairokud");
  if (!bin) throw new EnrollmentIncompleteError("kairokud not on PATH — cannot write kairoku.token");
  const result = await io.shell([bin, "settings", KAIROKUD_TOKEN_SETTING, "--stdin"], { stdin: token });
  if (result.code !== 0) {
    throw new EnrollmentIncompleteError(
      `kairokud settings ${KAIROKUD_TOKEN_SETTING} --stdin failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
}

async function acknowledgeEnrollment(
  io: Io,
  progress: EnrollmentProgress,
  installation: Installation,
): Promise<EnrollmentIdentity> {
  const bin = io.which("kairokud");
  if (!bin) throw new EnrollmentIncompleteError("kairokud not on PATH — cannot acknowledge enrollment");
  const result = await io.shell([
    bin,
    "link",
    "acknowledge",
    "--request-id",
    progress.requestId,
    "--installation-id",
    installation.installationId,
    "--backend-url",
    progress.backendUrl,
    "--json",
  ]);
  if (result.code !== 0) {
    throw new EnrollmentIncompleteError(
      `kairokud link acknowledge failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  let body: {
    state?: string;
    daemonId?: string;
    ownerId?: string;
    installationId?: string;
    requestId?: string;
  };
  try {
    body = JSON.parse(result.stdout) as typeof body;
  } catch {
    throw new EnrollmentIncompleteError("kairokud link acknowledge returned non-JSON");
  }
  if (body.state !== "activated" || !body.daemonId || !body.ownerId) {
    throw new EnrollmentIncompleteError("enrollment acknowledgement did not return activated identity");
  }
  if (body.installationId && body.installationId !== installation.installationId) {
    throw new EnrollmentIncompleteError("acknowledgement installationId mismatch");
  }
  return { daemonId: body.daemonId, ownerId: body.ownerId };
}

/**
 * Prove the cloud saw a heartbeat from this enrollment identity.
 * Uses the issued token only on the Authorization header (never logged).
 */
async function awaitHeartbeatProof(
  io: Io,
  backendUrl: string,
  token: string,
  expected: EnrollmentIdentity & { installationId: string },
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 30;
  const intervalMs = opts.intervalMs ?? Number(io.env.KAIROKU_ENROLLMENT_HEARTBEAT_MS ?? 1000);
  for (let i = 0; i < maxAttempts; i++) {
    const { status, json } = await postJson(
      io,
      `${backendUrl}/api/daemon/heartbeat`,
      {
        meta: {
          protocol: "1",
          host: io.env.HOSTNAME ?? hostname() ?? "machine",
          installationId: expected.installationId,
        },
      },
      { authorization: `Bearer ${token}` },
    );
    if (status === 200 && json && typeof json === "object") {
      const body = json as HeartbeatProof & { daemon?: { id?: string } };
      const daemonId = body.daemonId ?? body.daemon?.id;
      const ownerId = body.ownerId;
      const installationId = body.installationId;
      if (daemonId && daemonId !== expected.daemonId) {
        throw new EnrollmentIncompleteError(
          `heartbeat daemonId mismatch (incomplete setup; expected ${expected.daemonId})`,
        );
      }
      if (ownerId && ownerId !== expected.ownerId) {
        throw new EnrollmentIncompleteError("heartbeat ownerId mismatch (incomplete setup)");
      }
      if (installationId && installationId !== expected.installationId) {
        throw new EnrollmentIncompleteError("heartbeat installationId mismatch (incomplete setup)");
      }
      if (daemonId === expected.daemonId) {
        // ownerId may be omitted on older heartbeat shapes; prefer match when present
        if (!ownerId || ownerId === expected.ownerId) return;
      }
    }
    await sleep(intervalMs, io);
  }
  throw new EnrollmentIncompleteError("heartbeat proof timed out — account setup incomplete");
}

export type RunEnrollmentOpts = {
  backendUrl: string;
  /** Skip creating a new request; used by unit tests that seed progress. */
  seedApproved?: PollApproved;
  maxPolls?: number;
  maxHeartbeatAttempts?: number;
};

/**
 * Owner-changing enrollment refuses while status reports active/unresolved
 * work or pending reports. Same-owner credential rotation is always allowed.
 * Null counters (F01 unknown) do not block — only known positive counts do.
 */
export async function assertOwnerChangeAllowed(
  io: Io,
  previousOwnerId: string | undefined,
  nextOwnerId: string,
): Promise<void> {
  if (!previousOwnerId || previousOwnerId === nextOwnerId) return;
  const bin = io.which("kairokud");
  if (!bin) {
    throw new EnrollmentIncompleteError(
      "owner-changing enrollment refused: kairokud not on PATH to inspect active work",
    );
  }
  const status = await io.shell([bin, "status", "--json"]);
  if (status.code !== 0) {
    throw new EnrollmentIncompleteError(
      "owner-changing enrollment refused: could not read kairokud status for active work",
    );
  }
  let body: {
    activeAttempts?: number | null;
    unresolvedAttempts?: number | null;
    pendingReports?: number | null;
  };
  try {
    body = JSON.parse(status.stdout) as typeof body;
  } catch {
    throw new EnrollmentIncompleteError(
      "owner-changing enrollment refused: kairokud status --json was not valid JSON",
    );
  }
  const blockers: string[] = [];
  if (typeof body.activeAttempts === "number" && body.activeAttempts > 0) {
    blockers.push(`activeAttempts=${body.activeAttempts}`);
  }
  if (typeof body.unresolvedAttempts === "number" && body.unresolvedAttempts > 0) {
    blockers.push(`unresolvedAttempts=${body.unresolvedAttempts}`);
  }
  if (typeof body.pendingReports === "number" && body.pendingReports > 0) {
    blockers.push(`pendingReports=${body.pendingReports}`);
  }
  if (blockers.length > 0) {
    throw new EnrollmentIncompleteError(
      `owner-changing enrollment refused while active/unresolved work or pending reports exist (${blockers.join(", ")})`,
    );
  }
}

/**
 * Complete enrollment for `installation` against F02's cloud APIs.
 * Returns only non-secret identity. Throws {@link EnrollmentIncompleteError}
 * without printing success when proof fails.
 */
export async function runEnrollment(
  io: Io,
  installation: Installation,
  opts: RunEnrollmentOpts,
): Promise<EnrollmentIdentity> {
  const backendUrl = assertEnrollmentOrigin(opts.backendUrl);
  const existing = loadEnrollmentProgress(io, installation);
  let progress = existing;
  let approved: PollApproved;

  if (opts.seedApproved) {
    approved = opts.seedApproved;
    progress = {
      schemaVersion: 1,
      installationId: installation.installationId,
      requestId: existing?.requestId ?? "00000000-0000-4000-8000-000000000001",
      pollSecret: existing?.pollSecret ?? "seed-poll-secret",
      backendUrl,
      state: "approved",
    };
    saveEnrollmentProgress(io, installation, progress);
  } else {
    progress = await createOrResumeRequest(io, installation, backendUrl, existing);
    approved = await waitForApproval(io, installation, progress, { maxPolls: opts.maxPolls });
  }

  await assertOwnerChangeAllowed(io, existing?.ownerId ?? progress.ownerId, approved.ownerId);

  // Persist non-secret fields before the credential write so a crash mid-write resumes.
  progress = {
    ...progress,
    daemonId: approved.daemonId,
    ownerId: approved.ownerId,
    state: "approved",
  };
  saveEnrollmentProgress(io, installation, progress);

  await writeRustToken(io, approved.token);
  const identity = await acknowledgeEnrollment(io, progress, installation);

  try {
    await awaitHeartbeatProof(
      io,
      backendUrl,
      approved.token,
      {
        ...identity,
        installationId: installation.installationId,
      },
      { maxAttempts: opts.maxHeartbeatAttempts },
    );
  } catch (e) {
    // Retain resumable progress; do not claim success.
    throw e;
  }

  clearEnrollmentSecrets(io, installation, {
    ...progress,
    daemonId: identity.daemonId,
    ownerId: identity.ownerId,
    state: "activated",
  });

  return identity;
}

/**
 * Install a loopback-delivered Rust token through the same final installer
 * and identity proof path as cross-device enrollment (no poll secret).
 */
export async function installLoopbackRustToken(
  io: Io,
  installation: Installation,
  opts: { backendUrl: string; token: string; requestId: string; daemonId: string; ownerId: string },
): Promise<EnrollmentIdentity> {
  const backendUrl = assertEnrollmentOrigin(opts.backendUrl);
  const progress: EnrollmentProgress = {
    schemaVersion: 1,
    installationId: installation.installationId,
    requestId: opts.requestId,
    backendUrl,
    daemonId: opts.daemonId,
    ownerId: opts.ownerId,
    state: "approved",
  };
  saveEnrollmentProgress(io, installation, progress);
  await writeRustToken(io, opts.token);
  const identity = await acknowledgeEnrollment(io, progress, installation);
  await awaitHeartbeatProof(io, backendUrl, opts.token, {
    ...identity,
    installationId: installation.installationId,
  });
  clearEnrollmentSecrets(io, installation, {
    ...progress,
    daemonId: identity.daemonId,
    ownerId: identity.ownerId,
    state: "activated",
  });
  return identity;
}
