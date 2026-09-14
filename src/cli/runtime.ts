/**
 * Resolve the package-owned Rust kairokud installation without changing
 * legacy Bun lifecycle defaults (F01). Consumes `kairokud instance --json`;
 * never recomputes Rust data-root paths in the CLI.
 */

import type { Io } from "./io";

export type ServiceProfile = "macos-personal" | "linux-personal" | "linux-server";

export type Installation = {
  schemaVersion: 1;
  installationId: string;
  dataRoot: string;
  profile: ServiceProfile;
  executionUser: string;
  executable: string;
  service: {
    manager: "launchd" | "systemd";
    scope: "user" | "system";
    label: string;
    package: "homebrew" | "deb" | "direct";
  };
};

export type SetupAction = "install" | "start" | "preserve" | "refuse";

/**
 * Minimal setup decision table. Keep local to this module — no generic
 * lifecycle framework.
 */
export function chooseSetupAction(found: number, matching: boolean, running: boolean): SetupAction {
  if (found > 1 || (found === 1 && !matching)) return "refuse";
  if (found === 0) return "install";
  return running ? "preserve" : "start";
}

function isInstallation(value: unknown): value is Installation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.installationId !== "string" || !v.installationId) return false;
  if (typeof v.dataRoot !== "string" || !v.dataRoot) return false;
  if (typeof v.profile !== "string") return false;
  if (typeof v.executionUser !== "string") return false;
  if (typeof v.executable !== "string") return false;
  if (!v.service || typeof v.service !== "object") return false;
  return true;
}

/**
 * Ask the resolved `kairokud` binary for installation metadata.
 * - `null` when absent (no installation.json)
 * - throws on ambiguity or corrupt state without mutating anything
 */
export async function resolveRuntime(io: Io): Promise<Installation | null> {
  const bin = io.which("kairokud");
  if (!bin) return null;

  const result = await io.shell([bin, "instance", "--json"]);
  if (result.code !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // Only the explicit absent signal maps to null; other non-zero exits are hard errors.
    if (combined.includes("no installation.json")) {
      return null;
    }
    throw new Error(
      `kairokud instance --json failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`kairokud instance --json returned corrupt JSON: ${(e as Error).message}`);
  }
  if (!isInstallation(parsed)) {
    throw new Error("kairokud instance --json returned an invalid Installation document");
  }
  return parsed;
}

/**
 * Inventory helper for setup: count detected service owners and whether the
 * recorded installation matches. Ambiguity (found > 1) must refuse.
 */
export function decideFromInventory(opts: {
  owners: string[];
  matching: boolean;
  running: boolean;
}): SetupAction {
  return chooseSetupAction(opts.owners.length, opts.matching, opts.running);
}

export type RustLiveHealth = {
  ok: boolean;
  detail: string;
};

/**
 * Final setup health from the resolved Rust service (`status --json`), not the
 * Bun HTTP `/status` listener. Offline progress alone is not live proof.
 */
export async function probeRustLiveHealth(io: Io, attempts = 10): Promise<RustLiveHealth> {
  const bin = io.which("kairokud");
  if (!bin) return { ok: false, detail: "kairokud not on PATH" };
  for (let i = 0; i < attempts; i++) {
    const status = await io.shell([bin, "status", "--json"]);
    if (status.code === 0) {
      try {
        const body = JSON.parse(status.stdout) as {
          installationId?: string;
          daemonId?: string | null;
          ownerId?: string | null;
          processInstanceId?: string | null;
          heartbeatOk?: boolean;
          service?: { running?: boolean | null };
        };
        if (
          typeof body.installationId === "string" &&
          body.installationId &&
          typeof body.daemonId === "string" &&
          body.daemonId &&
          typeof body.ownerId === "string" &&
          body.ownerId &&
          typeof body.processInstanceId === "string" &&
          body.processInstanceId &&
          body.heartbeatOk === true
        ) {
          return {
            ok: true,
            detail: `kairokud status — daemon ${body.daemonId}, process ${body.processInstanceId}, heartbeat ok`,
          };
        }
      } catch {
        // retry
      }
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, detail: "kairokud status --json did not report live proof (installationId/daemonId/ownerId/processInstanceId/heartbeatOk)" };
}
