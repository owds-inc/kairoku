import { describe, expect, test } from "bun:test";
import type { QaResult } from "./qa";
import { MAX_FIX_ROUNDS, RECIPE_NAMES, readVerdict, recipeFor } from "./recipes";
import type { MemberContext, RoleTurn } from "./recipes";

const CLEAN = { verdict: "CLEAN", defects: [] };
const counts = { pass: 10, fail: 0, skip: 0, errors: 0 };

/**
 * A fake provider, one level up: the recipe never sees a model, a process or a
 * socket, so the state machine is what is under test and nothing else.
 */
function fakeCtx(script: {
  turns?: Array<Partial<RoleTurn> | undefined>;
  qa?: QaResult[];
  cancelAfter?: number;
}): MemberContext & { calls: Array<{ role: string; prompt: string }>; qaRuns: number } {
  const calls: Array<{ role: string; prompt: string }> = [];
  let qaRuns = 0;
  const ctx = {
    item: { id: "i1", key: null, title: "Ship the thing", body: "## Change\nDo it." },
    brief: "an extra note from the human",
    worktree: "/tmp/wt",
    calls,
    get qaRuns() {
      return qaRuns;
    },
    cancelled: () => script.cancelAfter !== undefined && calls.length >= script.cancelAfter,
    async runRole(role: string, prompt: string) {
      calls.push({ role, prompt });
      const next = script.turns?.[calls.length - 1];
      return { ok: true, summary: `${role} ok`, ...(next ?? {}) } as RoleTurn;
    },
    async qa() {
      const result = script.qa?.[qaRuns] ?? { ok: true, summary: "QA: 10 pass", counts };
      qaRuns++;
      return result;
    },
  };
  return ctx as unknown as MemberContext & { calls: Array<{ role: string; prompt: string }>; qaRuns: number };
}

describe("recipes — the table (§20.4)", () => {
  test("six teams, and the ones the app offers are exactly these", () => {
    expect([...RECIPE_NAMES]).toEqual(["solo", "build-verify", "phase-team", "plan", "research", "custom"]);
  });

  test("an unknown team is not run — it is refused", () => {
    expect(recipeFor("agent-led")).toBeUndefined();
    expect(recipeFor("")).toBeUndefined();
    expect(recipeFor("constructor")).toBeUndefined();
  });

  test("a phase team is build-and-verify per item: same machine, fanned out by the dispatch", () => {
    expect(recipeFor("phase-team")).toBe(recipeFor("build-verify"));
  });
});

describe("recipes — solo (implementer → QA)", () => {
  test("the happy path: one implementer, one QA, four counts", async () => {
    const ctx = fakeCtx({});
    const outcome = await recipeFor("solo")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["implementer"]);
    expect(ctx.qaRuns).toBe(1);
    expect(outcome).toMatchObject({ ok: true, counts });
  });

  test("an implementer that fails stops before QA", async () => {
    const ctx = fakeCtx({ turns: [{ ok: false, summary: "exit 3" }] });
    const outcome = await recipeFor("solo")!(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("exit 3");
    expect(ctx.qaRuns).toBe(0);
  });

  test("custom keeps the QA gate, because an implement run may not report done without counts", async () => {
    const ctx = fakeCtx({});
    await recipeFor("custom")!(ctx);
    expect(ctx.qaRuns).toBe(1);
  });
});

describe("recipes — build-verify (implementer → reviewer → fix loop → QA → fix loop)", () => {
  test("the happy path: implementer, a CLEAN reviewer, QA", async () => {
    const ctx = fakeCtx({ turns: [undefined, { report: CLEAN }] });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["implementer", "reviewer"]);
    expect(outcome).toMatchObject({ ok: true, counts });
  });

  test("NOT_CLEAN re-runs the implementer with the defects VERBATIM, then reviews again", async () => {
    const ctx = fakeCtx({
      turns: [
        undefined,
        { report: { verdict: "NOT_CLEAN", defects: ["src/a.ts: the guard passes when it cannot tell"] } },
        undefined,
        { report: CLEAN },
      ],
    });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["implementer", "reviewer", "implementer", "reviewer"]);
    expect(ctx.calls[2]!.prompt).toContain("src/a.ts: the guard passes when it cannot tell");
    expect(outcome.ok).toBe(true);
  });

  test("two fix rounds and still NOT_CLEAN is a failure, not a third round", async () => {
    const notClean = { report: { verdict: "NOT_CLEAN", defects: ["still broken"] } };
    const ctx = fakeCtx({ turns: [undefined, notClean, undefined, notClean, undefined, notClean] });
    const outcome = await recipeFor("build-verify")!(ctx);
    const reviews = ctx.calls.filter((c) => c.role === "reviewer");
    expect(reviews).toHaveLength(MAX_FIX_ROUNDS + 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("still broken");
    expect(ctx.qaRuns).toBe(0);
  });

  test("a reviewer with no structured report fails the run CLOSED", async () => {
    const ctx = fakeCtx({ turns: [undefined, { ok: true, report: undefined }] });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("no verdict");
    expect(ctx.qaRuns).toBe(0);
  });

  test("a reviewer whose report is not a verdict fails closed too", async () => {
    const ctx = fakeCtx({ turns: [undefined, { report: { verdict: "PROBABLY_FINE" } }] });
    expect((await recipeFor("build-verify")!(ctx)).ok).toBe(false);
  });

  test("a failing QA feeds the implementer's fix loop exactly as defects do", async () => {
    const failing: QaResult = {
      ok: false,
      summary: "QA: 8 pass · 2 fail · 0 skip · 0 errors",
      counts: { pass: 8, fail: 2, skip: 0, errors: 0 },
      defect: "expected true to be false at a.test.ts:12",
    };
    const ctx = fakeCtx({
      turns: [undefined, { report: CLEAN }, undefined],
      qa: [failing, { ok: true, summary: "QA: 10 pass", counts }],
    });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["implementer", "reviewer", "implementer"]);
    expect(ctx.calls[2]!.prompt).toContain("expected true to be false at a.test.ts:12");
    expect(outcome).toMatchObject({ ok: true, counts });
  });

  test("two QA fix rounds and still failing reports the counts it actually saw", async () => {
    const failing: QaResult = {
      ok: false,
      summary: "QA: 8 pass · 2 fail · 0 skip · 0 errors",
      counts: { pass: 8, fail: 2, skip: 0, errors: 0 },
      defect: "nope",
    };
    const ctx = fakeCtx({ turns: [undefined, { report: CLEAN }], qa: [failing, failing, failing] });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(ctx.qaRuns).toBe(MAX_FIX_ROUNDS + 1);
    expect(outcome).toMatchObject({ ok: false, counts: { pass: 8, fail: 2, skip: 0, errors: 0 } });
  });
});

describe("recipes — plan and research (the primary role, then a reviewer)", () => {
  test("plan is planner then reviewer, and the planner's report is the outcome", async () => {
    const ctx = fakeCtx({ turns: [{ report: { phases: [] } }, { report: CLEAN }] });
    const outcome = await recipeFor("plan")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["planner", "reviewer"]);
    expect(outcome).toMatchObject({ ok: true, report: { phases: [] } });
    // No suite is run for a plan: there is nothing to test.
    expect(ctx.qaRuns).toBe(0);
  });

  test("research is researcher then reviewer", async () => {
    const ctx = fakeCtx({ turns: [{ report: { documentIds: ["d"] } }, { report: CLEAN }] });
    await recipeFor("research")!(ctx);
    expect(ctx.calls.map((c) => c.role)).toEqual(["researcher", "reviewer"]);
  });

  test("a planner whose report never arrives fails closed", async () => {
    const ctx = fakeCtx({ turns: [{ ok: true, report: undefined }] });
    const outcome = await recipeFor("plan")!(ctx);
    expect(outcome.ok).toBe(false);
    expect(ctx.calls.map((c) => c.role)).toEqual(["planner"]);
  });
});

describe("recipes — cancel", () => {
  test("a cancel between steps ends the member instead of starting the next role", async () => {
    const ctx = fakeCtx({ turns: [undefined, { report: { verdict: "NOT_CLEAN", defects: ["x"] } }], cancelAfter: 2 });
    const outcome = await recipeFor("build-verify")!(ctx);
    expect(outcome).toMatchObject({ ok: false, summary: "cancelled by the app" });
    expect(ctx.calls).toHaveLength(2);
  });

  test("a cancel before anything starts runs no role at all", async () => {
    const ctx = fakeCtx({ cancelAfter: 0 });
    expect(await recipeFor("solo")!(ctx)).toMatchObject({ ok: false, summary: "cancelled by the app" });
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("recipes — the verdict reader", () => {
  test("reads CLEAN and NOT_CLEAN with their defects", () => {
    expect(readVerdict({ verdict: "CLEAN", defects: [] })).toEqual({ clean: true, defects: [] });
    expect(readVerdict({ verdict: "NOT_CLEAN", defects: ["a", "b"] })).toEqual({ clean: false, defects: ["a", "b"] });
  });

  test("anything that is not one of the two words is not a verdict", () => {
    expect(readVerdict(undefined)).toBeUndefined();
    expect(readVerdict("CLEAN")).toBeUndefined();
    expect(readVerdict({ verdict: "clean" })).toBeUndefined();
    expect(readVerdict({ defects: [] })).toBeUndefined();
  });

  test("NOT_CLEAN with no defects is still a verdict, and says so in the fix prompt", () => {
    expect(readVerdict({ verdict: "NOT_CLEAN" })).toEqual({ clean: false, defects: [] });
  });
});
