/**
 * §20.4 — a team is a RECIPE: deterministic code in the daemon that decides who
 * runs when, not an agent deciding whom to spawn.
 *
 * Everything here is a state machine over run records. It never sees a model, a
 * process, a worktree or a socket: `MemberContext` hands it `runRole` and `qa`,
 * and `dispatch.ts` is what wires those to real providers. That is why the
 * whole table can be tested against a fake in a few milliseconds, and why a
 * change to the Agent SDK cannot change what `build-verify` means.
 *
 * THE TWO GATES FAIL CLOSED, and both matter more than they look:
 *
 *   A reviewer's verdict is a STRUCTURED REPORT, never a prose block. A missing
 *   or unreadable one fails the run, because "the reviewer said it looked fine"
 *   read out of free text is exactly the claim invariant 7 exists to refuse.
 *
 *   QA is a deterministic daemon step (`qa.ts`, grill Q2). A failing suite feeds
 *   the implementer's fix loop exactly as a reviewer's defects do — the same
 *   loop, the same budget, no special case.
 *
 * Fix loops are ≤ 2 PER GATE (grill Q14), then the member fails with what it
 * last saw. A third attempt at the same defect is not persistence, it is a way
 * of spending an hour to arrive at the same place.
 */

import type { SuiteCounts } from "./app";
import type { QaResult } from "./qa";
import type { RoleName } from "./policy";

export const RECIPE_NAMES = ["solo", "build-verify", "phase-team", "plan", "research", "custom"] as const;
export type RecipeName = (typeof RECIPE_NAMES)[number];

export const MAX_FIX_ROUNDS = 2;

/** The verdict every reviewer turn must produce. Mirrored in `plugin/agents/reviewer.md`. */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["CLEAN", "NOT_CLEAN"] },
    defects: { type: "array", items: { type: "string" } },
  },
  required: ["verdict"],
  additionalProperties: false,
};

/** What a planner files. Ids only — the app mirrors what the agent wrote under its own token. */
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    documentIds: { type: "array", items: { type: "string" } },
  },
  required: ["summary"],
};

export const RESEARCH_SCHEMA = PLAN_SCHEMA;

export interface RoleTurn {
  readonly ok: boolean;
  readonly summary: string;
  readonly report?: unknown;
}

export interface MemberItem {
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  readonly body: string;
}

export interface MemberContext {
  readonly item: MemberItem;
  /** The human's note on top of the item bodies. Usually empty, by design. */
  readonly brief: string;
  readonly worktree: string;
  runRole(role: RoleName, prompt: string, schema?: Record<string, unknown>): Promise<RoleTurn>;
  qa(): Promise<QaResult>;
  cancelled(): boolean;
}

export interface MemberOutcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly counts?: SuiteCounts;
  readonly report?: unknown;
}

export type Recipe = (ctx: MemberContext) => Promise<MemberOutcome>;

// ------------------------------------------------------------------- verdicts

export function readVerdict(report: unknown): { clean: boolean; defects: string[] } | undefined {
  if (!report || typeof report !== "object") return undefined;
  const { verdict, defects } = report as { verdict?: unknown; defects?: unknown };
  if (verdict !== "CLEAN" && verdict !== "NOT_CLEAN") return undefined;
  return {
    clean: verdict === "CLEAN",
    defects: Array.isArray(defects) ? defects.filter((d): d is string => typeof d === "string") : [],
  };
}

// -------------------------------------------------------------------- prompts

const CANCELLED: MemberOutcome = { ok: false, summary: "cancelled by the app" };

function buildPrompt(ctx: MemberContext): string {
  return [
    `# ${ctx.item.title}`,
    ctx.item.key ? `Jira: ${ctx.item.key}` : "",
    "",
    ctx.item.body,
    ctx.brief ? `\n## Also from the human\n\n${ctx.brief}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function reviewPrompt(ctx: MemberContext): string {
  return [
    `Review the work on this item in ${ctx.worktree}.`,
    "",
    buildPrompt(ctx),
    "",
    "Answer with the structured verdict and nothing else.",
  ].join("\n");
}

/**
 * The defects go in VERBATIM (§20.4). Paraphrasing a reviewer's finding into a
 * fix instruction is how a fix loop ends up addressing a different bug.
 */
function fixPrompt(ctx: MemberContext, source: string, defects: string[]): string {
  return [
    `The ${source} did not pass. Fix exactly these, in ${ctx.worktree}, and nothing else:`,
    "",
    ...(defects.length ? defects.map((d) => `- ${d}`) : ["- (no detail was given; re-read the item and the diff)"]),
    "",
    "The item, for context:",
    "",
    buildPrompt(ctx),
  ].join("\n");
}

// --------------------------------------------------------------------- gates

/**
 * A reviewer gate with its fix loop. Shared by build-verify, plan and research,
 * because "run the primary role, have it reviewed, fix what came back, at most
 * twice" is the same machine in all three.
 */
async function reviewGate(ctx: MemberContext, fixWith: RoleName): Promise<MemberOutcome | undefined> {
  for (let round = 0; ; round++) {
    if (ctx.cancelled()) return CANCELLED;
    const turn = await ctx.runRole("reviewer", reviewPrompt(ctx), REVIEW_SCHEMA);
    if (!turn.ok) return { ok: false, summary: `the reviewer did not finish: ${turn.summary}` };

    const verdict = readVerdict(turn.report);
    if (!verdict) {
      return {
        ok: false,
        summary: "the reviewer returned no verdict this daemon can read — the run fails closed (§20.4)",
      };
    }
    if (verdict.clean) return undefined;

    if (round >= MAX_FIX_ROUNDS) {
      return {
        ok: false,
        summary: `still NOT_CLEAN after ${MAX_FIX_ROUNDS} fix rounds: ${verdict.defects.join("; ") || "no detail given"}`,
      };
    }
    if (ctx.cancelled()) return CANCELLED;
    const fix = await ctx.runRole(fixWith, fixPrompt(ctx, "review", verdict.defects));
    if (!fix.ok) return { ok: false, summary: `the ${fixWith} failed on a fix round: ${fix.summary}` };
  }
}

/** The QA gate with the same loop and the same budget. Counts always travel out. */
async function qaGate(ctx: MemberContext): Promise<MemberOutcome> {
  let last: QaResult | undefined;
  for (let round = 0; ; round++) {
    if (ctx.cancelled()) return CANCELLED;
    last = await ctx.qa();
    if (last.ok) {
      return { ok: true, summary: last.summary, ...(last.counts === undefined ? {} : { counts: last.counts }) };
    }
    if (round >= MAX_FIX_ROUNDS) {
      return { ok: false, summary: last.summary, ...(last.counts === undefined ? {} : { counts: last.counts }) };
    }
    if (ctx.cancelled()) return CANCELLED;
    const fix = await ctx.runRole("implementer", fixPrompt(ctx, "QA step", last.defect ? [last.defect] : []));
    if (!fix.ok) {
      return {
        ok: false,
        summary: `the implementer failed on a QA fix round: ${fix.summary}`,
        ...(last.counts === undefined ? {} : { counts: last.counts }),
      };
    }
  }
}

/** One primary turn whose own structured report IS the deliverable. */
async function reportingRole(
  ctx: MemberContext,
  role: RoleName,
  schema: Record<string, unknown>,
): Promise<MemberOutcome> {
  if (ctx.cancelled()) return CANCELLED;
  const turn = await ctx.runRole(role, buildPrompt(ctx), schema);
  if (!turn.ok) return { ok: false, summary: `the ${role} did not finish: ${turn.summary}` };
  if (turn.report === undefined) {
    return { ok: false, summary: `the ${role} returned no report — the run fails closed (§20.4)` };
  }
  const review = await reviewGate(ctx, role);
  return review ?? { ok: true, summary: turn.summary, report: turn.report };
}

// -------------------------------------------------------------------- the table

const buildVerify: Recipe = async (ctx) => {
  if (ctx.cancelled()) return CANCELLED;
  const built = await ctx.runRole("implementer", buildPrompt(ctx));
  if (!built.ok) return { ok: false, summary: `the implementer did not finish: ${built.summary}` };

  const review = await reviewGate(ctx, "implementer");
  if (review) return review;
  return qaGate(ctx);
};

const solo: Recipe = async (ctx) => {
  if (ctx.cancelled()) return CANCELLED;
  const built = await ctx.runRole("implementer", buildPrompt(ctx));
  if (!built.ok) return { ok: false, summary: `the implementer did not finish: ${built.summary}` };
  return qaGate(ctx);
};

const RECIPES: Record<RecipeName, Recipe> = {
  solo,
  "build-verify": buildVerify,
  // A phase team IS build-and-verify — per item, in parallel. The fan-out is
  // the DISPATCH's (one worktree and branch per member, bounded by capacity),
  // so there is nothing different for a member to do.
  "phase-team": buildVerify,
  plan: (ctx) => reportingRole(ctx, "planner", PLAN_SCHEMA),
  research: (ctx) => reportingRole(ctx, "researcher", RESEARCH_SCHEMA),
  // The escape hatch KEEPS THE QA GATE: the app refuses an `implement` run
  // reporting done without all four counts, so a custom team with no suite
  // behind it could only ever report failed.
  custom: solo,
};

export function recipeFor(name: string): Recipe | undefined {
  return Object.prototype.hasOwnProperty.call(RECIPES, name) ? RECIPES[name as RecipeName] : undefined;
}

/** The names advertised in the beat's `meta.recipes`. */
export function recipeNames(): string[] {
  return [...RECIPE_NAMES];
}

/** Which role a recipe leads with — the role a run reports at launch. */
export function leadRole(name: string): RoleName {
  if (name === "plan") return "planner";
  if (name === "research") return "researcher";
  return "implementer";
}

/** The schema a role must answer with, when it must answer with one. */
export function schemaFor(role: RoleName): Record<string, unknown> | undefined {
  if (role === "reviewer") return REVIEW_SCHEMA;
  if (role === "planner") return PLAN_SCHEMA;
  if (role === "researcher") return RESEARCH_SCHEMA;
  return undefined;
}
