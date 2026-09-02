/**
 * RF-003 — per-run JSONL event log at <runsDir>/<runId>/events.jsonl, alongside
 * the captured stdout.log. A log, not state: nothing reads it back.
 *
 * Nothing written here may carry a credential (RF-008). Callers pass only the
 * fields below; `env` never reaches this module.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "created"
  | "started"
  | "finished"
  | "teardown"
  | "error";

export interface EventFields {
  readonly [key: string]: string | number | boolean | undefined;
}

export function runDir(runsDir: string, runId: string): string {
  return join(runsDir, runId);
}

export function stdoutPath(runsDir: string, runId: string): string {
  return join(runDir(runsDir, runId), "stdout.log");
}

export function eventsPath(runsDir: string, runId: string): string {
  return join(runDir(runsDir, runId), "events.jsonl");
}

export function ensureRunDir(runsDir: string, runId: string): string {
  const dir = runDir(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one event. Never throws into the caller's control flow. */
export function appendEvent(
  runsDir: string,
  runId: string,
  type: EventType,
  fields: EventFields = {},
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...fields });
  try {
    appendFileSync(eventsPath(runsDir, runId), line + "\n");
  } catch {
    // The event log is diagnostics. Losing a line must not fail a run.
  }
}
