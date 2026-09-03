/**
 * The one provider interface (§20 item 1).
 *
 * `launch(run) → { events, interrupt(), exit }`, and nothing above this line
 * knows whether a role is being driven by the Claude Agent SDK or by
 * `codex exec`. That is what makes the recipes testable against a fake: a
 * recipe is a state machine over run records and provider exits, and it never
 * touches a model, a process or a socket itself.
 *
 * A LEAF MODULE — types and one constant. It imports the role vocabulary and
 * the event vocabulary, and nothing else, so that `claude.ts` can stay the only
 * file in the daemon that has ever heard of the SDK.
 */

import type { EventKind } from "../events";
import type { RoleName } from "../policy";
import type { Rules } from "../rules";

export type ProviderName = "claude" | "codex";

export interface ProviderEvent {
  readonly kind: EventKind;
  readonly text: string;
}

/** One role, one turn, one worktree. */
export interface RoleRun {
  readonly dispatchId: string;
  readonly runId: string;
  readonly role: RoleName;
  /** The model the composer chose for this role; the provider's default when absent. */
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The whole brief for this turn: the role prompt, the item body, any defects. */
  readonly prompt: string;
  /** Absolute path of the run's worktree — the agent's working root. */
  readonly cwd: string;
  /** Injected over the daemon's environment; carries `KAIROKU_PAT`. */
  readonly env: Record<string, string>;
  /**
   * When set, the turn must end with a report matching this JSON Schema. A
   * missing or invalid one FAILS THE RUN CLOSED (§20.4) — a reviewer that
   * cannot produce a verdict has not reviewed anything.
   */
  readonly schema?: Record<string, unknown>;
  /**
   * §21 — the repo's own rules, as the base branch has them, materialised once
   * per dispatch. Absent means the repo declares none, and nothing scans.
   */
  readonly rules?: Rules;
  readonly timeoutMs: number;
  /** Where the raw provider stream is captured, for the post-mortem. */
  readonly logPath: string;
}

export interface ProviderExit {
  readonly ok: boolean;
  readonly summary: string;
  /** The structured report, when a schema was asked for and one came back. */
  readonly report?: unknown;
  /** Recorded in the run's json so a human can resume the same session. */
  readonly sessionId?: string;
}

export interface LaunchedRun {
  readonly events: AsyncIterable<ProviderEvent>;
  /** Stop this turn. Idempotent; safe before the process exists. */
  interrupt(): void;
  readonly exit: Promise<ProviderExit>;
}

export interface Provider {
  readonly name: ProviderName;
  launch(run: RoleRun): LaunchedRun;
  /** What this tool says it can drive, for the beat's `providers` map. */
  models(): Promise<string[]>;
}
