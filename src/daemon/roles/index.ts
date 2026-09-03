/**
 * §20.5 — Codex has no plugin agents, so the daemon writes its role prompts.
 *
 * The SAME FOUR ROLES the plugin defines for Claude (`plugin/agents/*.md`),
 * said again in the form codex takes: a prompt on stdin. They are markdown
 * files rather than string literals so they read as prose and diff as prose,
 * and they are TEXT IMPORTS rather than `readFileSync` so the compiled binary
 * carries them — there is no `src/` beside a released `kairoku`.
 */

import type { RoleName } from "../policy";
import implementer from "./implementer.md" with { type: "text" };
import planner from "./planner.md" with { type: "text" };
import researcher from "./researcher.md" with { type: "text" };
import reviewer from "./reviewer.md" with { type: "text" };

const PROMPTS: Record<RoleName, string> = { implementer, reviewer, planner, researcher };

export function rolePrompt(role: RoleName): string {
  return PROMPTS[role];
}

export function rolesWithPrompts(): string[] {
  return Object.keys(PROMPTS);
}
