/**
 * Cross-device cloud enrollment through the resolved Rust daemon (F03 / FRV08).
 *
 * Flow: request → poll (private progress) → protected stdin token write →
 * `kairokud link acknowledge` → live Rust status proof. Credentials never
 * appear in argv, printed lines, or the returned identity.
 *
 * Installed authority (`installedOwnerId` / `installedDaemonId`) is separate
 * from the pending request and survives pending enrollment and refusal.
 */

import { join } from "node:path";
import { hostname } from "node:os";
import type { Io } from "./io";
import type { Installation } from "./runtime";
import { kairokuHome, normaliseAppUrl, parseEnvFile } from "../daemon/config";

export const ENROLLMENT_PROGRESS_FILE = "enrollment-progress.json";
export const KAIROKUD_TOKEN_SETTING = "kairoku.token";
export const LOCAL_ADMISSION_FILE = "local-admission.json";

/** Private on-disk poll progress (mode 0600). Secrets cleared after live proof. */
export type EnrollmentProgress = {
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  /** Present only while polling; cleared after live proof completes. */
  pollSecret?: string;
  backendUrl: string;
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  /** Non-secret receipt fields for the current attempt. */
  daemonId?: string;
  ownerId?: string;
  state?: string;
  /** Durable installed authority — survives pending enrollment and refusal. */
  installedOwnerId?: string;
  installedDaemonId?: string;
  /** Prior terminal attempt preserved when starting a fresh request. */
  priorRequestId?: string;
  priorState?: string;
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

const TERMINAL_BEFORE_ACTIVATION = new Set(["denied", "cancelled", "expired", "not_found"]);

function progressPath(io: Io, installation: Installation): string {
  const root = installation.dataRoot || join(kairokuHome(io.home), "data");
  return join(root, ENROLLMENT_PROGRESS_FILE);
}

export function loadEnrollmentProgress(io: Io, installation: Installation): EnrollmentProgress | null {
  const path = progressPath(io, installation);
  const raw = io.readFile(path);
  if (raw === null) {
    if (io.exists(path)) throw new EnrollmentIncompleteError("enrollment progress is unreadable");
    return null;
  }
  let parsed: EnrollmentProgress;
  try {
    parsed = JSON.parse(raw) as EnrollmentProgress;
  } catch {
    throw new EnrollmentIncompleteError("enrollment progress is corrupt");
  }
  if (parsed.schemaVersion !== 1) {
    throw new EnrollmentIncompleteError(`enrollment progress schema ${String(parsed.schemaVersion)} is unsupported`);
  }
  if (parsed.installationId !== installation.installationId) {
    throw new EnrollmentIncompleteError("enrollment progress installation mismatch");
  }
  return parsed;
}

export function saveEnrollmentProgress(
  io: Io,
  installation: Installation,
  progress: EnrollmentProgress,
): void {
  const path = progressPath(io, installation);
  const temp = `${path}.tmp`;
  io.writeFile(temp, `${JSON.stringify(progress, null, 2)}\n`, 0o600);
  io.rename(temp, path);
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
    ...(progress.installedOwnerId ? { installedOwnerId: progress.installedOwnerId } : {}),
    ...(progress.installedDaemonId ? { installedDaemonId: progress.installedDaemonId } : {}),
    ...(progress.priorRequestId ? { priorRequestId: progress.priorRequestId } : {}),
    ...(progress.priorState ? { priorState: progress.priorState } : {}),
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

function sleep(ms: number, io: Io): Promise<void> {
  const override = io.env.KAIROKU_ENROLLMENT_POLL_MS;
  const wait = override !== undefined ? Number(override) : ms;
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(wait) ? wait : ms));
}

/** Authoritative installed owner: explicit field, else activated owner, else unknown. */
export function installedAuthorityOwner(progress: EnrollmentProgress | null): string | undefined {
  if (!progress) return undefined;
  return progress.installedOwnerId ?? (progress.state === "activated" || progress.state === "live_proof"
    ? progress.ownerId
    : undefined);
}

function hasRustSecretsToken(io: Io, path: string): boolean {
  if (!io.exists(path)) return false;
  const raw = io.readFile(path);
  if (!raw) return true; // unreadable → fail safe, treat as credential present
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.["kairoku.token"] === "string" && parsed["kairoku.token"].length > 0;
  } catch {
    return true; // malformed JSON → fail safe, treat as credential present
  }
}

function hasCredentialHint(io: Io, installation: Installation): boolean {
  // Only Rust link credentials count here. The Bun predecessor's
  // KAIROKU_DAEMON_TOKEN is inventoried by migration, not a Rust credential —
  // a linked Bun predecessor must be able to enroll Rust for the first time.
  const secrets = join(installation.dataRoot, ".secrets.json");
  const legacySecrets = join(installation.dataRoot, "secrets.json");
  if (hasRustSecretsToken(io, secrets) || hasRustSecretsToken(io, legacySecrets)) return true;
  const tokenEnv = join(kairokuHome(io.home), "token.env");
  const raw = io.readFile(tokenEnv);
  if (!raw) return false;
  const parsed = parseEnvFile(raw);
  return Boolean(parsed.KAIROKUD_LINK_TOKEN);
}

/**
 * Missing owner with an existing credential is unknown, not a fresh install.
 * Blocks owner-changing enrollment when status cannot prove idle work.
 */
export async function assertOwnerChangeAllowed(
  io: Io,
  previousOwnerId: string | undefined,
  nextOwnerId: string,
  opts: { credentialPresent?: boolean } = {},
): Promise<void> {
  if (previousOwnerId && previousOwnerId === nextOwnerId) return;
  if (!previousOwnerId && opts.credentialPresent) {
    throw new EnrollmentIncompleteError(
      "owner-changing enrollment refused: installed owner is unknown while a credential exists — cannot prove safe replacement",
    );
  }
  if (!previousOwnerId) return;
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
  const counters: Array<[string, unknown]> = [
    ["activeAttempts", body.activeAttempts],
    ["unresolvedAttempts", body.unresolvedAttempts],
    ["pendingReports", body.pendingReports],
  ];
  const unknown: string[] = [];
  const blockers: string[] = [];
  for (const [name, value] of counters) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      unknown.push(name);
      continue;
    }
    if (value > 0) blockers.push(`${name}=${value}`);
  }
  if (unknown.length > 0) {
    throw new EnrollmentIncompleteError(
      `owner-changing enrollment refused: kairokud status counters unknown (${unknown.join(", ")}) — cannot prove idle work`,
    );
  }
  if (blockers.length > 0) {
    throw new EnrollmentIncompleteError(
      `owner-changing enrollment refused while active/unresolved work or pending reports exist (${blockers.join(", ")})`,
    );
  }
}

/**
 * Before replacement credential when a legacy predecessor exists: latch FRV07
 * durable migration inhibition in the resolved Rust data root.
 */
export function ensureMigrationInhibition(io: Io, installation: Installation): void {
  const path = join(installation.dataRoot, LOCAL_ADMISSION_FILE);
  const existing = io.readFile(path);
  let base: Record<string, unknown> = {
    schema: 1,
    revision: 1,
    claimsInhibited: false,
    paused: false,
    humanApproved: false,
    outcomeKnown: true,
    instanceReconciled: true,
    activeOrUnresolved: false,
    unresolvedAttempts: false,
  };
  if (existing !== null && existing !== "") {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>;
      if (parsed.schema !== 1) {
        throw new EnrollmentIncompleteError(
          "local-admission.json unreadable or corrupt — cannot establish migration inhibition",
        );
      }
      base = parsed;
    } catch (e) {
      if (e instanceof EnrollmentIncompleteError) throw e;
      throw new EnrollmentIncompleteError(
        "local-admission.json unreadable or corrupt — cannot establish migration inhibition",
      );
    }
  } else if (existing === null && io.exists(path)) {
    throw new EnrollmentIncompleteError(
      "local-admission.json unreadable or corrupt — cannot establish migration inhibition",
    );
  }
  if (base.maintenancePurpose === "migration" && base.claimsInhibited === true) {
    return;
  }
  const revision = typeof base.revision === "number" ? base.revision : 1;
  const next = {
    ...base,
    schema: 1,
    previousRevision: revision,
    revision: revision + 1,
    claimsInhibited: true,
    maintenanceOperationId:
      typeof base.maintenanceOperationId === "string" && base.maintenancePurpose === "migration"
        ? base.maintenanceOperationId
        : `enrollment-migration-${installation.installationId}`,
    maintenancePurpose: "migration",
    reason: "FRV08 replacement enrollment with legacy predecessor",
  };
  io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

/** Detect a legacy Bun predecessor that would be replaced by Rust enrollment. */
export function hasLegacyPredecessor(io: Io): boolean | "unknown" {
  const tokenPath = join(kairokuHome(io.home), "token.env");
  if (!io.exists(tokenPath)) return false;
  const raw = io.readFile(tokenPath);
  if (raw === null) return "unknown";
  try {
    const parsed = parseEnvFile(raw);
    return Boolean(parsed.KAIROKU_DAEMON_TOKEN);
  } catch {
    return "unknown";
  }
}

async function createOrResumeRequest(
  io: Io,
  installation: Installation,
  backendUrl: string,
  existing: EnrollmentProgress | null,
): Promise<EnrollmentProgress> {
  // Denied/expired/cancelled before activation → preserve prior, then fresh request.
  if (existing?.state && TERMINAL_BEFORE_ACTIVATION.has(existing.state)) {
    const priorRequestId = existing.requestId;
    const priorState = existing.state;
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
      ...(existing.installedOwnerId ? { installedOwnerId: existing.installedOwnerId } : {}),
      ...(existing.installedDaemonId ? { installedDaemonId: existing.installedDaemonId } : {}),
      priorRequestId,
      priorState,
    };
    saveEnrollmentProgress(io, installation, progress);
    return progress;
  }

  // pending/approved with poll secret → resume same request.
  if (
    existing?.requestId &&
    existing.pollSecret &&
    existing.backendUrl === backendUrl &&
    (!existing.state || existing.state === "pending" || existing.state === "approved")
  ) {
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
    ...(existing?.installedOwnerId ? { installedOwnerId: existing.installedOwnerId } : {}),
    ...(existing?.installedDaemonId ? { installedDaemonId: existing.installedDaemonId } : {}),
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
      // Cloud says activated — resume via ack/proof with installed credential.
      throw new EnrollmentIncompleteError(
        "enrollment already activated; resume acknowledgement/proof without a new request",
      );
    }
    if (TERMINAL_BEFORE_ACTIVATION.has(result.state)) {
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
 * Live proof from the resolved Rust service status — not a CLI-synthesized heartbeat.
 * Requires installationId, daemonId, ownerId, processInstanceId and heartbeatOk.
 */
async function awaitLiveRustProof(
  io: Io,
  expected: EnrollmentIdentity & { installationId: string; backendUrl: string },
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const bin = io.which("kairokud");
  if (!bin) throw new EnrollmentIncompleteError("kairokud not on PATH — cannot obtain live proof");
  const maxAttempts = opts.maxAttempts ?? 30;
  const intervalMs = opts.intervalMs ?? Number(io.env.KAIROKU_ENROLLMENT_HEARTBEAT_MS ?? 1000);
  for (let i = 0; i < maxAttempts; i++) {
    const status = await io.shell([bin, "status", "--json"]);
    if (status.code === 0) {
      try {
        const body = JSON.parse(status.stdout) as {
          installationId?: string;
          daemonId?: string | null;
          ownerId?: string | null;
          processInstanceId?: string | null;
          heartbeatOk?: boolean;
          backendUrl?: string | null;
          service?: { running?: boolean | null };
        };
        const installationId = body.installationId;
        const daemonId = body.daemonId;
        const ownerId = body.ownerId;
        const processInstanceId = body.processInstanceId;
        const heartbeatOk = body.heartbeatOk === true;
        if (
          installationId === expected.installationId &&
          daemonId === expected.daemonId &&
          ownerId === expected.ownerId &&
          typeof processInstanceId === "string" &&
          processInstanceId.length > 0 &&
          heartbeatOk &&
          body.backendUrl === expected.backendUrl
        ) {
          return;
        }
      } catch (e) {
        if (e instanceof EnrollmentIncompleteError) throw e;
      }
    }
    await sleep(intervalMs, io);
  }
  throw new EnrollmentIncompleteError("live Rust proof timed out — account setup incomplete");
}

export type RunEnrollmentOpts = {
  backendUrl: string;
  /** Skip creating a new request; used by unit tests that seed progress. */
  seedApproved?: PollApproved;
  maxPolls?: number;
  maxHeartbeatAttempts?: number;
  /** Already-active compatible token (loopback) — skip ack request minting. */
  alreadyActiveToken?: {
    token: string;
    daemonId: string;
    ownerId: string;
    /** When set, still acknowledge this F02 request. */
    requestId?: string;
  };
};

function resumePhase(progress: EnrollmentProgress | null): string {
  return progress?.state ?? "none";
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
  const credentialPresent = hasCredentialHint(io, installation);
  const phase = resumePhase(existing);

  // Live proof complete → verify current service/identity; return existing setup.
  if (phase === "live_proof" && existing?.installedDaemonId && existing.installedOwnerId) {
    await awaitLiveRustProof(
      io,
      {
        daemonId: existing.installedDaemonId,
        ownerId: existing.installedOwnerId,
        installationId: installation.installationId,
        backendUrl: existing.backendUrl || backendUrl,
      },
      { maxAttempts: opts.maxHeartbeatAttempts },
    );
    return { daemonId: existing.installedDaemonId, ownerId: existing.installedOwnerId };
  }

  // Activated but live proof incomplete → reuse activation; no new request/token.
  if (
    (phase === "activated" || phase === "acknowledging") &&
    existing?.daemonId &&
    existing.ownerId &&
    credentialPresent
  ) {
    const identity = { daemonId: existing.daemonId, ownerId: existing.ownerId };
    if (phase === "acknowledging") {
      const ack = await acknowledgeEnrollment(io, existing, installation);
      identity.daemonId = ack.daemonId;
      identity.ownerId = ack.ownerId;
    }
    await awaitLiveRustProof(
      io,
      { ...identity, installationId: installation.installationId, backendUrl },
      { maxAttempts: opts.maxHeartbeatAttempts },
    );
    clearEnrollmentSecrets(io, installation, {
      ...existing,
      daemonId: identity.daemonId,
      ownerId: identity.ownerId,
      installedDaemonId: identity.daemonId,
      installedOwnerId: identity.ownerId,
      state: "live_proof",
    });
    return identity;
  }

  // Already-active compatible token (loopback): install + proof without inventing ack.
  if (opts.alreadyActiveToken && !opts.alreadyActiveToken.requestId) {
    const prev = installedAuthorityOwner(existing);
    await assertOwnerChangeAllowed(io, prev, opts.alreadyActiveToken.ownerId, {
      credentialPresent: credentialPresent || Boolean(prev),
    });
    const predecessor = hasLegacyPredecessor(io);
    if (predecessor === "unknown") {
      throw new EnrollmentIncompleteError(
        "unreadable predecessor inventory — cannot enable uncontrolled replacement",
      );
    }
    if (predecessor) ensureMigrationInhibition(io, installation);
    const progress: EnrollmentProgress = {
      schemaVersion: 1,
      installationId: installation.installationId,
      requestId: existing?.requestId ?? "already-active",
      backendUrl,
      daemonId: opts.alreadyActiveToken.daemonId,
      ownerId: opts.alreadyActiveToken.ownerId,
      installedDaemonId: opts.alreadyActiveToken.daemonId,
      installedOwnerId: opts.alreadyActiveToken.ownerId,
      state: "activated",
      ...(existing?.installedOwnerId ? { installedOwnerId: existing.installedOwnerId } : {}),
      ...(existing?.installedDaemonId ? { installedDaemonId: existing.installedDaemonId } : {}),
    };
    // Prefer new identity once owner-change cleared.
    progress.installedDaemonId = opts.alreadyActiveToken.daemonId;
    progress.installedOwnerId = opts.alreadyActiveToken.ownerId;
    saveEnrollmentProgress(io, installation, progress);
    await writeRustToken(io, opts.alreadyActiveToken.token);
    const identity = {
      daemonId: opts.alreadyActiveToken.daemonId,
      ownerId: opts.alreadyActiveToken.ownerId,
    };
    await awaitLiveRustProof(
      io,
      { ...identity, installationId: installation.installationId, backendUrl },
      { maxAttempts: opts.maxHeartbeatAttempts },
    );
    clearEnrollmentSecrets(io, installation, { ...progress, state: "live_proof" });
    return identity;
  }

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
      ...(existing?.installedOwnerId ? { installedOwnerId: existing.installedOwnerId } : {}),
      ...(existing?.installedDaemonId ? { installedDaemonId: existing.installedDaemonId } : {}),
    };
    saveEnrollmentProgress(io, installation, progress);
  } else if (opts.alreadyActiveToken?.requestId) {
    // Pending F02 request with loopback token — still acknowledge.
    approved = {
      state: "approved",
      daemonId: opts.alreadyActiveToken.daemonId,
      token: opts.alreadyActiveToken.token,
      ownerId: opts.alreadyActiveToken.ownerId,
      installationId: installation.installationId,
    };
    progress = {
      schemaVersion: 1,
      installationId: installation.installationId,
      requestId: opts.alreadyActiveToken.requestId,
      backendUrl,
      daemonId: approved.daemonId,
      ownerId: approved.ownerId,
      state: "approved",
      ...(existing?.installedOwnerId ? { installedOwnerId: existing.installedOwnerId } : {}),
      ...(existing?.installedDaemonId ? { installedDaemonId: existing.installedDaemonId } : {}),
      ...(existing?.pollSecret ? { pollSecret: existing.pollSecret } : {}),
    };
    saveEnrollmentProgress(io, installation, progress);
  } else {
    progress = await createOrResumeRequest(io, installation, backendUrl, existing);
    approved = await waitForApproval(io, installation, progress, { maxPolls: opts.maxPolls });
  }

  const previousOwner = installedAuthorityOwner(existing) ?? installedAuthorityOwner(progress);
  await assertOwnerChangeAllowed(io, previousOwner, approved.ownerId, {
    credentialPresent: credentialPresent || Boolean(previousOwner === undefined && hasCredentialHint(io, installation)),
  });

  const predecessor = hasLegacyPredecessor(io);
  if (predecessor === "unknown") {
    throw new EnrollmentIncompleteError(
      "unreadable predecessor inventory — cannot enable uncontrolled replacement",
    );
  }
  if (predecessor) ensureMigrationInhibition(io, installation);

  progress = {
    ...progress,
    daemonId: approved.daemonId,
    ownerId: approved.ownerId,
    state: "approved",
  };
  saveEnrollmentProgress(io, installation, progress);

  await writeRustToken(io, approved.token);
  progress = { ...progress, state: "acknowledging" };
  saveEnrollmentProgress(io, installation, progress);

  const identity = await acknowledgeEnrollment(io, progress, installation);

  try {
    await awaitLiveRustProof(
      io,
      {
        ...identity,
        installationId: installation.installationId,
        backendUrl,
      },
      { maxAttempts: opts.maxHeartbeatAttempts },
    );
  } catch (e) {
    // Retain resumable activated progress; do not claim success.
    saveEnrollmentProgress(io, installation, {
      ...progress,
      daemonId: identity.daemonId,
      ownerId: identity.ownerId,
      installedDaemonId: identity.daemonId,
      installedOwnerId: identity.ownerId,
      state: "activated",
    });
    throw e;
  }

  clearEnrollmentSecrets(io, installation, {
    ...progress,
    daemonId: identity.daemonId,
    ownerId: identity.ownerId,
    installedDaemonId: identity.daemonId,
    installedOwnerId: identity.ownerId,
    state: "live_proof",
  });

  return identity;
}

/**
 * Install a loopback-delivered Rust token through the same final installer
 * and identity proof path as cross-device enrollment.
 *
 * Pending F02 request → acknowledge. Already-active compatible token →
 * shared install/proof without inventing an acknowledgement request.
 * Missing identity cannot bypass owner-change protection.
 */
export async function installLoopbackRustToken(
  io: Io,
  installation: Installation,
  opts: {
    backendUrl: string;
    token: string;
    daemonId?: string;
    ownerId?: string;
    requestId?: string;
  },
): Promise<EnrollmentIdentity> {
  const backendUrl = assertEnrollmentOrigin(opts.backendUrl);
  if (!opts.daemonId || !opts.ownerId) {
    throw new EnrollmentIncompleteError(
      "loopback enrollment refused: missing daemon/owner identity — cannot bypass owner-change protection",
    );
  }
  return runEnrollment(io, installation, {
    backendUrl,
    alreadyActiveToken: {
      token: opts.token,
      daemonId: opts.daemonId,
      ownerId: opts.ownerId,
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    },
  });
}
