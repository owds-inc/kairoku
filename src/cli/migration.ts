/**
 * Controlled Bun → Rust daemon cutover (F08 / FRV09). Resumable states; never
 * disables legacy startup while unresolved work remains unless the human
 * dispositions that exact record. Does not rewrite tokens, transfer provider
 * processes, or auto-run both runtimes. Drain and disable always target the
 * inventoried predecessor — never the replacement Rust service label.
 */

import { join } from "node:path";
import { kairokuHome } from "../daemon/config";
import type { Io } from "./io";
import type { Installation } from "./runtime";
import { SYSTEMD_UNIT } from "./service";

export type MigrationState =
  | "inventory"
  | "draining"
  | "reconciled"
  | "legacy_disabled"
  | "rust_proven"
  | "blocked"
  | "complete";

export type MigrationResult = {
  state: MigrationState;
  blockers: string[];
};

/** Inventoried Bun predecessor identity — never Rust metadata. */
export type PredecessorIdentity = {
  executable: string;
  dataRoot: string;
  executionUser: string;
  manager: "launchd" | "systemd" | "unknown";
  scope: "user" | "system" | "unknown";
  label: string;
  enrolled: boolean;
};

export type ReplacementIdentity = {
  executable: string;
  dataRoot: string;
  executionUser: string;
  manager: Installation["service"]["manager"];
  scope: Installation["service"]["scope"];
  label: string;
  installationId: string;
};

export type MigrationReceipt = {
  schemaVersion: 1;
  state: MigrationState;
  blockers: string[];
  oldOwners: string[];
  newOwners: string[];
  serviceLabels: string[];
  unresolved: string[];
  dispositioned: string[];
  oldDaemonId?: string;
  newDaemonId?: string;
  predecessor?: PredecessorIdentity;
  replacement?: ReplacementIdentity;
  migrationOperationId?: string;
};

const RECEIPT = "migration-receipt.json";

export function migrationReceiptPath(home: string): string {
  return join(kairokuHome(home), RECEIPT);
}

export function loadReceipt(io: Io): MigrationReceipt | null {
  const raw = io.readFile(migrationReceiptPath(io.home));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationReceipt;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveReceipt(io: Io, receipt: MigrationReceipt): void {
  io.writeFile(migrationReceiptPath(io.home), `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

export function handoffComplete(io: Io): boolean {
  const receipt = loadReceipt(io);
  return receipt?.state === "complete";
}

/**
 * Inventory the Bun predecessor. Missing home is absence (fresh install).
 * Unreadable config/token is unknown — never coerce to empty.
 */
export function inventoryPredecessor(io: Io): PredecessorIdentity | null | "unknown" {
  const home = kairokuHome(io.home);
  const configPath = join(home, "config.json");
  const tokenPath = join(home, "token.env");
  const hasConfig = io.exists(configPath);
  const hasToken = io.exists(tokenPath);
  if (!hasConfig && !hasToken) return null;

  if (hasConfig) {
    const raw = io.readFile(configPath);
    if (raw === null) return "unknown";
    try {
      JSON.parse(raw);
    } catch {
      return "unknown";
    }
  }
  if (hasToken) {
    const raw = io.readFile(tokenPath);
    if (raw === null) return "unknown";
  }

  let enrolled = false;
  if (hasToken) {
    const raw = io.readFile(tokenPath) ?? "";
    enrolled = /(?:^|\n)\s*KAIROKU_DAEMON_TOKEN\s*=\s*\S+/m.test(raw);
  }

  const manager: PredecessorIdentity["manager"] =
    io.platform === "darwin" ? "launchd" : io.platform === "linux" ? "systemd" : "unknown";
  let scope: PredecessorIdentity["scope"] = "user";
  let label = SYSTEMD_UNIT;
  if (manager === "launchd") {
    // Historical Bun LaunchAgent shared the Rust label; inventory records that.
    label = "io.kairoku.daemon";
    scope = "user";
  } else if (manager === "systemd") {
    const systemUnit = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;
    const userUnit = join(io.home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
    if (io.exists(systemUnit)) scope = "system";
    else if (io.exists(userUnit)) scope = "user";
    else scope = "unknown";
    label = SYSTEMD_UNIT;
  }

  return {
    executable: io.execPath,
    dataRoot: home,
    executionUser: io.env.USER ?? "",
    manager,
    scope,
    label,
    enrolled,
  };
}

export type LegacyProbe =
  | { readonly ok: true; readonly activeRuns: number; readonly pendingReports: number; readonly claimsInFlight: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Probe Bun /status. Unavailable, malformed, or missing counters are unknown —
 * never coerced to zero (FRV09/C7).
 */
export async function probeLegacyActive(io: Io, predecessor?: PredecessorIdentity | null): Promise<LegacyProbe> {
  const home = predecessor?.dataRoot ?? kairokuHome(io.home);
  const configPath = join(home, "config.json");
  if (!io.exists(configPath)) {
    return { ok: false, reason: "legacy_config_missing" };
  }
  const raw = io.readFile(configPath);
  if (raw === null) return { ok: false, reason: "legacy_config_unreadable" };
  let host = "127.0.0.1";
  let port = 7801;
  try {
    const parsed = JSON.parse(raw) as { listen?: { host?: string; port?: number } };
    host = parsed.listen?.host ?? host;
    port = parsed.listen?.port ?? port;
  } catch {
    return { ok: false, reason: "legacy_config_malformed" };
  }
  try {
    const res = await io.fetch(`http://${host}:${port}/status`);
    if (!res.ok) return { ok: false, reason: "legacy_status_http" };
    const body = (await res.json()) as {
      runs?: unknown[];
      capacity?: { running?: unknown };
      link?: { pendingReports?: unknown; claimsInFlight?: unknown };
    };
    const activeRuns =
      typeof body.capacity?.running === "number"
        ? body.capacity.running
        : Array.isArray(body.runs)
          ? body.runs.length
          : null;
    const pendingReports =
      typeof body.link?.pendingReports === "number" ? body.link.pendingReports : null;
    const claimsInFlight =
      typeof body.link?.claimsInFlight === "number"
        ? body.link.claimsInFlight
        : body.link === undefined
          ? 0
          : null;
    if (activeRuns === null || pendingReports === null || claimsInFlight === null) {
      return { ok: false, reason: "legacy_status_counters_unknown" };
    }
    return { ok: true, activeRuns, pendingReports, claimsInFlight };
  } catch {
    return { ok: false, reason: "legacy_status_unreachable" };
  }
}

async function drainPredecessor(
  io: Io,
  predecessor: PredecessorIdentity,
): Promise<{ ok: boolean; claimsInFlight: number }> {
  const tokenPath = join(predecessor.dataRoot, "drain.token");
  const token = io.readFile(tokenPath)?.trim() ?? "";
  const fileMode = io.mode(tokenPath);
  const dirMode = io.mode(predecessor.dataRoot);
  if (!/^[0-9a-f]{64}$/.test(token) || fileMode !== 0o600 || dirMode !== 0o700) {
    return { ok: false, claimsInFlight: 0 };
  }
  let host = "127.0.0.1";
  let port = 7801;
  try {
    const parsed = JSON.parse(io.readFile(join(predecessor.dataRoot, "config.json")) ?? "{}") as {
      listen?: { host?: string; port?: number };
    };
    host = parsed.listen?.host ?? host;
    port = parsed.listen?.port ?? port;
  } catch {
    return { ok: false, claimsInFlight: 0 };
  }
  try {
    const res = await io.fetch(`http://${host}:${port}/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, claimsInFlight: 0 };
    const body = (await res.json()) as { claimsInFlight?: unknown };
    const claimsInFlight = typeof body.claimsInFlight === "number" ? body.claimsInFlight : 0;
    return { ok: true, claimsInFlight };
  } catch {
    return { ok: false, claimsInFlight: 0 };
  }
}

async function disablePredecessor(
  io: Io,
  predecessor: PredecessorIdentity,
): Promise<boolean> {
  const { manager, scope, label } = predecessor;
  if (manager === "unknown" || scope === "unknown" || !label) return false;
  if (manager === "launchd") {
    const target = `gui/${io.uid}/${label}`;
    const bootout = await io.shell(["launchctl", "bootout", target]);
    return bootout.code === 0;
  }
  if (manager === "systemd") {
    const ctl = scope === "system" ? ["sudo", "systemctl"] : ["systemctl", "--user"];
    const disable = await io.shell([...ctl, "disable", "--now", label]);
    return disable.code === 0;
  }
  return false;
}

/**
 * Persist FRV07 migration inhibition in the replacement root before cutover
 * proves the live Rust path. Returns the operation id for later release.
 */
export function ensureReplacementInhibition(io: Io, installation: Installation): string | null {
  const path = join(installation.dataRoot, "local-admission.json");
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
      if (parsed.schema !== 1) return null;
      base = parsed;
    } catch {
      return null;
    }
  } else if (existing === null && io.exists(path)) {
    return null;
  }
  if (base.maintenancePurpose === "migration" && base.claimsInhibited === true) {
    return typeof base.maintenanceOperationId === "string" ? base.maintenanceOperationId : null;
  }
  const revision = typeof base.revision === "number" ? base.revision : 1;
  const opId =
    typeof base.maintenanceOperationId === "string" && base.maintenancePurpose === "migration"
      ? base.maintenanceOperationId
      : `migration-${installation.installationId}`;
  const next = {
    ...base,
    schema: 1,
    previousRevision: revision,
    revision: revision + 1,
    claimsInhibited: true,
    maintenanceOperationId: opId,
    maintenancePurpose: "migration",
    reason: "FRV09 legacy handoff — replacement admission inhibited",
  };
  io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return opId;
}

/** Release only the matching migration operation after verified handoff. */
export function releaseMigrationInhibition(
  io: Io,
  installation: Installation,
  operationId: string | undefined,
): boolean {
  if (!operationId) return false;
  const path = join(installation.dataRoot, "local-admission.json");
  const raw = io.readFile(path);
  if (!raw) return false;
  try {
    const base = JSON.parse(raw) as Record<string, unknown>;
    if (base.schema !== 1) return false;
    if (base.maintenanceOperationId !== operationId) return false;
    if (base.maintenancePurpose !== "migration") return false;
    const revision = typeof base.revision === "number" ? base.revision : 1;
    const humanDrain = base.humanDrain === true;
    const next = {
      ...base,
      previousRevision: revision,
      revision: revision + 1,
      claimsInhibited: humanDrain,
      maintenanceOperationId: null,
      maintenancePurpose: null,
      stagedVersion: null,
      reason: humanDrain ? "human drain still latched after migration clear" : null,
    };
    io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return true;
  } catch {
    return false;
  }
}

export type MigrationOptions = {
  /** Human dispositions for unresolved records — each id is allowed to proceed. */
  readonly dispositioned?: readonly string[];
  /** When true, attempt disable/prove/complete after reconcile (human-directed). */
  readonly cutover?: boolean;
};

/**
 * Drive migration. Default stops at reconciled/blocked — cutover requires
 * `opts.cutover` and zero blockers. Never kills processes or disables services
 * while unresolved evidence remains. Never accepts a blanket disposition string
 * as permission to discard all active runs.
 */
export async function runMigration(
  io: Io,
  installation: Installation,
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const dispositioned = [...(opts.dispositioned ?? [])];
  const prior = loadReceipt(io);
  const receipt: MigrationReceipt = prior ?? {
    schemaVersion: 1,
    state: "inventory",
    blockers: [],
    oldOwners: [],
    newOwners: [],
    serviceLabels: [],
    unresolved: [],
    dispositioned: [],
  };

  receipt.state = "inventory";
  const predecessor = inventoryPredecessor(io);
  if (predecessor === "unknown") {
    receipt.state = "blocked";
    receipt.blockers = ["predecessor_inventory_unknown"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  const replacement: ReplacementIdentity = {
    executable: installation.executable,
    dataRoot: installation.dataRoot,
    executionUser: installation.executionUser,
    manager: installation.service.manager,
    scope: installation.service.scope,
    label: installation.service.label,
    installationId: installation.installationId,
  };
  receipt.replacement = replacement;
  receipt.newOwners = [installation.executionUser];
  receipt.newDaemonId = installation.installationId;

  if (predecessor === null) {
    // Fresh install — positively established absence of a predecessor.
    receipt.oldOwners = [];
    receipt.serviceLabels = [replacement.label];
    receipt.predecessor = undefined;
    receipt.state = "complete";
    receipt.blockers = [];
    receipt.unresolved = [];
    saveReceipt(io, receipt);
    return { state: "complete", blockers: [] };
  }

  receipt.predecessor = predecessor;
  receipt.oldOwners = [`bun-legacy:${predecessor.label}`];
  receipt.serviceLabels = [predecessor.label, replacement.label];
  const opId = ensureReplacementInhibition(io, installation);
  if (!opId) {
    receipt.state = "blocked";
    receipt.blockers = ["replacement_inhibition_failed"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }
  receipt.migrationOperationId = opId;
  saveReceipt(io, receipt);

  receipt.state = "draining";
  saveReceipt(io, receipt);
  const drain = await drainPredecessor(io, predecessor);
  if (!drain.ok) {
    receipt.state = "blocked";
    receipt.blockers = ["drain_failed"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  receipt.state = "reconciled";
  const live = await probeLegacyActive(io, predecessor);
  const unresolved: string[] = [...(prior?.unresolved ?? [])];
  if (!live.ok) {
    unresolved.push(live.reason);
  } else {
    if (live.activeRuns > 0) unresolved.push("legacy_active_run");
    if (live.pendingReports > 0) unresolved.push("legacy_pending_report");
    if (live.claimsInFlight > 0 || drain.claimsInFlight > 0) unresolved.push("legacy_claim_in_flight");
  }
  receipt.unresolved = [...new Set(unresolved)];
  receipt.dispositioned = dispositioned;
  // Only exact recorded ids may be dispositioned — never a blanket "all".
  const blockers = receipt.unresolved.filter((id) => !dispositioned.includes(id));
  receipt.blockers = blockers;
  if (blockers.length > 0) {
    receipt.state = "blocked";
    saveReceipt(io, receipt);
    return { state: "blocked", blockers };
  }
  saveReceipt(io, receipt);

  if (!opts.cutover) {
    return { state: "reconciled", blockers: [] };
  }

  // Explicit human-directed cutover only — disable the inventoried predecessor.
  receipt.state = "legacy_disabled";
  saveReceipt(io, receipt);
  if (!(await disablePredecessor(io, predecessor))) {
    receipt.state = "blocked";
    receipt.blockers = ["legacy_disable_failed"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  receipt.state = "rust_proven";
  saveReceipt(io, receipt);
  const rustBin = io.which("kairokud") ?? installation.executable;
  const status = await io.shell([rustBin, "status", "--json"]);
  if (status.code !== 0) {
    receipt.state = "blocked";
    receipt.blockers = ["rust_not_proven"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }
  try {
    const body = JSON.parse(status.stdout) as {
      service?: { running?: boolean | null };
      installationId?: string;
      dataRoot?: string;
    };
    if (body.service?.running !== true) {
      receipt.state = "blocked";
      receipt.blockers = ["rust_not_proven"];
      saveReceipt(io, receipt);
      return { state: "blocked", blockers: receipt.blockers };
    }
    // Same-root live Rust evidence — installation id must match replacement.
    if (body.installationId && body.installationId !== installation.installationId) {
      receipt.state = "blocked";
      receipt.blockers = ["rust_identity_mismatch"];
      saveReceipt(io, receipt);
      return { state: "blocked", blockers: receipt.blockers };
    }
  } catch {
    receipt.state = "blocked";
    receipt.blockers = ["rust_not_proven"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  releaseMigrationInhibition(io, installation, receipt.migrationOperationId);
  receipt.state = "complete";
  receipt.blockers = [];
  saveReceipt(io, receipt);
  return { state: "complete", blockers: [] };
}
