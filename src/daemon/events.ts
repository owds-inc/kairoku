/**
 * RF-003 — the per-run log on disk, and (O-3, §20 item 7) the curated channel
 * that rides the heartbeat.
 *
 * TWO LOGS, ONE TRUTH. Everything a provider emits is appended to
 * `<runsDir>/<dispatchId>/<runId>.jsonl` in full, forever, on this machine.
 * What travels to the app is a CURATION of it: ≤ 2 KB a line, tool calls
 * summarised, delivered values masked, at most 50 lines a beat, oldest dropped
 * first with one line saying how many. The wire is a viewport onto the log, not
 * the log — which is why a full disk costs the local record and not the run,
 * and why a lost beat costs lines and not the file.
 *
 * Nothing written here may carry a credential (RF-008). The buffer is told the
 * run's secret values and masks them on the way in, so a provider that echoes
 * one back cannot leak it into either log.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type EventType = "created" | "started" | "finished" | "teardown" | "error";

export interface EventFields {
  readonly [key: string]: string | number | boolean | undefined;
}

/** One run dir per DISPATCH; a team's members share it, one file set each. */
export function runDir(runsDir: string, dispatchId: string): string {
  return join(runsDir, dispatchId);
}

export function stdoutPath(runsDir: string, dispatchId: string, runId: string): string {
  return join(runDir(runsDir, dispatchId), `${runId}.log`);
}

export function eventsPath(runsDir: string, dispatchId: string, runId: string): string {
  return join(runDir(runsDir, dispatchId), `${runId}.jsonl`);
}

export function ensureRunDir(runsDir: string, dispatchId: string): string {
  const dir = runDir(runsDir, dispatchId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one structured event. Never throws into the caller's control flow. */
export function appendEvent(
  runsDir: string,
  dispatchId: string,
  runId: string,
  type: EventType,
  fields: EventFields = {},
): void {
  writeLine(eventsPath(runsDir, dispatchId, runId), { ts: new Date().toISOString(), type, ...fields });
}

function writeLine(path: string, value: unknown): void {
  try {
    appendFileSync(path, JSON.stringify(value) + "\n");
  } catch {
    // The event log is diagnostics. Losing a line must not fail a run.
  }
}

// ------------------------------------------------------------ the curated wire

/** The app's vocabulary, vendored from `src/lib/comms/protocol/index.ts`. */
export type EventKind = "text" | "tool" | "ok" | "deny" | "error";

export const EVENT_TEXT_MAX = 2048;
export const EVENTS_PER_REPORT_MAX = 50;

/** Shorter than this and a "secret" is a word, not a credential. */
const MASKABLE_MIN = 8;
export const MASK = "••••";

export interface CuratedEvent {
  readonly seq: number;
  readonly ts: string;
  readonly kind: EventKind;
  readonly text: string;
}

export interface EventBufferOptions {
  readonly runsDir: string;
  readonly dispatchId: string;
  readonly runId: string;
  /** Values delivered to this run. Masked in both logs, longest first. */
  readonly secrets?: readonly string[];
  readonly max?: number;
}

/** Replace every occurrence of a delivered value. Longest first, so a value that contains another is masked whole. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length >= MASKABLE_MIN).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MASK);
  }
  return out;
}

export class EventBuffer {
  readonly #path: string;
  readonly #secrets: readonly string[];
  readonly #max: number;
  readonly #pending: CuratedEvent[] = [];
  #seq = 0;
  #dropped = 0;
  /** The seq of the FIRST line dropped since the last drain — the notice takes it. */
  #dropSeq = 0;

  constructor(options: EventBufferOptions) {
    // The run dir may not exist yet: a provider can emit before the worktree
    // step that would otherwise have created it.
    try {
      ensureRunDir(options.runsDir, options.dispatchId);
    } catch {
      // Unwritable runs dir: the curated channel still works, the log does not.
    }
    this.#path = eventsPath(options.runsDir, options.dispatchId, options.runId);
    this.#secrets = options.secrets ?? [];
    this.#max = options.max ?? EVENTS_PER_REPORT_MAX;
  }

  push(kind: EventKind, text: string): void {
    const event = this.#event(kind, text);
    writeLine(this.#path, event);
    // The DISK keeps everything; only the wire buffer is bounded.
    if (this.#pending.length >= this.#max) {
      const gone = this.#pending.shift()!;
      // The notice inherits the seq of the first line it stands in for, taken
      // HERE rather than at drain: a seq minted at drain time is higher than
      // every line the notice precedes, and the app orders a batch by seq.
      if (this.#dropped === 0) this.#dropSeq = gone.seq;
      this.#dropped++;
    }
    this.#pending.push(event);
  }

  pending(): number {
    return this.#pending.length;
  }

  /**
   * Take up to `max` lines for the next beat.
   *
   * An overflow notice takes the first slot rather than being appended, so a
   * reader sees "n lines are missing" BEFORE the lines that survived, and the
   * batch still never exceeds the cap the app enforces. The line the notice
   * displaces is not lost — it is the oldest still pending, and it leads the
   * next beat, which is what `seq` ordering is for.
   *
   * And the notice carries the seq of the first line it replaces, so EVERY
   * delivered batch is monotonic by seq — including the one after a drop. That
   * seq was never delivered (the line it belonged to was dropped), so nothing
   * collides.
   */
  drain(max: number = this.#max): CuratedEvent[] {
    if (this.#dropped === 0) return this.#pending.splice(0, max);
    const notice: CuratedEvent = {
      seq: this.#dropSeq,
      ts: new Date().toISOString(),
      kind: "error",
      text: `${this.#dropped} earlier event lines were dropped to keep the buffer at ${this.#max}`,
    };
    this.#dropped = 0;
    return [notice, ...this.#pending.splice(0, Math.max(0, max - 1))];
  }

  #event(kind: EventKind, text: string): CuratedEvent {
    return {
      seq: this.#seq++,
      ts: new Date().toISOString(),
      kind,
      text: truncate(maskSecrets(text, this.#secrets)),
    };
  }
}

function truncate(text: string): string {
  return text.length <= EVENT_TEXT_MAX ? text : `${text.slice(0, EVENT_TEXT_MAX - 1)}…`;
}
