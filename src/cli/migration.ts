/**
 * Controlled Bun → Rust daemon cutover (F08). Resumable states; never disables
 * legacy startup while unresolved work remains unless the human dispositions it.
 * Does not rewrite tokens, transfer provider processes, or auto-run both runtimes.
 */

import { join } from "node:path";
import { kairokuHome } from "../daemon/config";
import type { Io } from "./io";
import type { Installation } from "./runtime";

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
};

const RECEIPT = "migration-receipt.json";

export function migrationReceiptPath(home: string): string {
  return join(kairokuHome(home), RECEIPT);
}

function loadReceipt(io: Io): MigrationReceipt | null {
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

/** Probe Bun /status for in-flight runs. Stale heartbeat alone is not enough. */
export async function probeLegacyActive(io: Io): Promise<{ activeRuns: number; pendingReports: number }> {
  const home = kairokuHome(io.home);
  let host = "127.0.0.1";
  let port = 7801;
  try {
    const parsed = JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as {
      listen?: { host?: string; port?: number };
    };
    host = parsed.listen?.host ?? host;
    port = parsed.listen?.port ?? port;
  } catch {
    return { activeRuns: 0, pendingReports: 0 };
  }
  try {
    const res = await io.fetch(`http://${host}:${port}/status`);
    if (!res.ok) return { activeRuns: 0, pendingReports: 0 };
    const body = (await res.json()) as {
      runs?: unknown[];
      capacity?: { running?: number };
      link?: { pendingReports?: number };
    };
    const activeRuns =
      typeof body.capacity?.running === "number"
        ? body.capacity.running
        : Array.isArray(body.runs)
          ? body.runs.length
          : 0;
    const pendingReports =
      typeof body.link?.pendingReports === "number" ? body.link.pendingReports : 0;
    return { activeRuns, pendingReports };
  } catch {
    return { activeRuns: 0, pendingReports: 0 };
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
 * while `legacy_active_run` (or similar) remains.
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
    newOwners: [installation.executionUser],
    serviceLabels: [installation.service.label],
    unresolved: [],
    dispositioned: [],
  };

  receipt.state = "inventory";
  const home = kairokuHome(io.home);
  const owners: string[] = [];
  if (io.exists(join(home, "config.json"))) owners.push("bun-legacy");
  if (installation.installationId) owners.push(`rust:${installation.installationId}`);
  receipt.oldOwners = owners;
  receipt.serviceLabels = [installation.service.label];
  receipt.newOwners = [installation.executionUser];
  saveReceipt(io, receipt);

  receipt.state = "draining";
  saveReceipt(io, receipt);
  const drainBin = io.which("kairokud") ?? installation.executable;
  const drain = await io.shell([drainBin, "drain", "--json"]);
  if (drain.code !== 0) {
    receipt.state = "blocked";
    receipt.blockers = ["drain_failed"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  receipt.state = "reconciled";
  const live = await probeLegacyActive(io);
  const unresolved: string[] = [...(prior?.unresolved ?? [])];
  if (live.activeRuns > 0) unresolved.push("legacy_active_run");
  if (live.pendingReports > 0) unresolved.push("legacy_pending_report");
  receipt.unresolved = [...new Set(unresolved)];
  receipt.dispositioned = dispositioned;
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

  // Explicit human-directed cutover only — F09 owns production enrolled machines.
  receipt.state = "legacy_disabled";
  saveReceipt(io, receipt);
  const { manager, scope, label } = installation.service;
  if (manager === "launchd") {
    const target = `gui/${io.uid}/${label}`;
    const bootout = await io.shell(["launchctl", "bootout", target]);
    if (bootout.code !== 0) {
      receipt.state = "blocked";
      receipt.blockers = ["legacy_disable_failed"];
      saveReceipt(io, receipt);
      return { state: "blocked", blockers: receipt.blockers };
    }
  } else {
    const ctl = scope === "system" ? ["sudo", "systemctl"] : ["systemctl", "--user"];
    const disable = await io.shell([...ctl, "disable", "--now", label]);
    if (disable.code !== 0) {
      receipt.state = "blocked";
      receipt.blockers = ["legacy_disable_failed"];
      saveReceipt(io, receipt);
      return { state: "blocked", blockers: receipt.blockers };
    }
  }

  receipt.state = "rust_proven";
  saveReceipt(io, receipt);
  const status = await io.shell([drainBin, "status", "--json"]);
  if (status.code !== 0) {
    receipt.state = "blocked";
    receipt.blockers = ["rust_not_proven"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }
  try {
    const body = JSON.parse(status.stdout) as { service?: { running?: boolean | null } };
    if (body.service?.running !== true) {
      receipt.state = "blocked";
      receipt.blockers = ["rust_not_proven"];
      saveReceipt(io, receipt);
      return { state: "blocked", blockers: receipt.blockers };
    }
  } catch {
    receipt.state = "blocked";
    receipt.blockers = ["rust_not_proven"];
    saveReceipt(io, receipt);
    return { state: "blocked", blockers: receipt.blockers };
  }

  receipt.state = "complete";
  receipt.blockers = [];
  saveReceipt(io, receipt);
  return { state: "complete", blockers: [] };
}
