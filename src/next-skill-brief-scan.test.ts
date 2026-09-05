import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * KAIR-374 — `plugin/skills/next/SKILL.md` no longer assembles its first
 * answer from two separate Kairoku calls; it asks for the session brief in
 * one. A scan rather than a manual re-read because the failure mode is
 * silent: the skill's own prose is never exercised by anything else in this
 * suite, so a future edit could quietly reintroduce the two-call assembly
 * and nothing would notice.
 *
 * The sprint step is asserted PRESENT, not absent — KAIR-374's own body says
 * to replace "the first two steps" of the ladder, but step 2 is
 * `kairoku-jira sprint current` / `sprint issues`: LIVE sprint state the
 * brief's `jira` field (`getJiraRollup`, a last-synced rollup) does not
 * carry. Removing it would lose information nothing replaces, so it stayed —
 * only step 1's two-call assembly was folded into the one brief call.
 */
const ROOT = path.resolve(import.meta.dir, "..");
const SKILL = readFileSync(path.join(ROOT, "plugin/skills/next/SKILL.md"), "utf8");

describe("plugin/skills/next/SKILL.md reads the brief instead of assembling it", () => {
  test("step 1 asks for get_project with the brief flag", () => {
    expect(SKILL).toContain("get_project");
    expect(SKILL).toContain("brief: true");
  });

  test("the old two-call assembly ('get_project ... then get_plan') is gone from step 1", () => {
    expect(SKILL).not.toContain("then `get_plan` for the current release");
  });

  test("the sprint step is KEPT — live sprint state the brief does not carry", () => {
    expect(SKILL).toContain("kairoku-jira sprint current");
    expect(SKILL).toContain("sprint issues");
  });

  test("the terminal answer keeps its 100-word budget, distinct from the app's 200", () => {
    expect(SKILL).toContain("Under 100 words");
  });
});
