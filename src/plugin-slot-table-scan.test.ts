import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * KAIR-548 — FR-085. The plan skill's slot table against the release template's
 * box slots.
 *
 * WHAT IT DEFENDS
 * ---------------
 * `plugin/skills/plan/SKILL.md` names every slot a release box seeds, with the
 * document class each one carries. Nothing else exercises that table: it is read
 * by a model at runtime, in someone else's session, and a slot added to or renamed
 * in the template leaves the skill quietly describing a tree that no longer exists.
 *
 * The parser reads the TABLE, not the file, and that is the point rather than
 * fussiness. `PLAN_SKILL.includes(name)` passed on prose — "PRD" already appears in
 * the skill's opening paragraph, `Release Notes` and `Retrospective` each occur again
 * in the commentary under the table — so those rows could be deleted outright and the
 * check stayed green. It was also one-directional: a slot REMOVED from the template
 * left its stale row in the skill and nothing complained. Set equality on the parsed
 * rows fails in both directions, and the class column is asserted too, because a table
 * naming every slot with the wrong class is exactly as misleading as one missing a slot.
 *
 * WHERE THE SLOT LIST COMES FROM (cli-2, DECISIONS §44.1)
 * ------------------------------------------------------
 * This guard was the fourth group of the app's `src/plugin-release-scan.test.ts`. The
 * plugin is canonical in the CLI repo (§19.4), so when app-11b deletes the app's plugin
 * copy that scan goes with it — and the other three groups CANNOT come here: they pin
 * `plugin.json`'s version at `2.2.0` and a manifest carrying `bikerwhocodes` URLs, while
 * this repository's canonical manifest is v2.4.1 with owds-inc URLs. Syncing that pair
 * backwards is what §37.5f forbids, so only this group moved (§44.2).
 *
 * `boxSlots()` from the app's `src/lib/template/tree.ts` does not exist here. app-17
 * exported it instead: `contracts/mcp-tools.json` gained a `boxSlots` key of
 * `{ name, docClass }` rows, IMPORTED from `tree.ts` and never parsed out of it, and
 * `fixtures/app-contract/mcp-tools.json` is a byte-for-byte copy of that file. The list
 * is sorted by name — the only consumer compares as a SET, which is this file, so tree
 * order is not part of the contract; a consumer that ever needs it gets an explicit
 * `order` field rather than an unsorted array.
 *
 * WHAT THE MOVE COSTS, SAID PLAINLY RATHER THAN LEFT TO BE REDISCOVERED.
 * The control below still proves this scan's COMPARISON detects drift — a renamed slot,
 * a deleted row, a wrong class, a table that stops being a table. It no longer proves
 * the slot list is the LIVE template's, because there is no template here. That half
 * lives in the app, in `scripts/export-mcp-contract.test.ts`: FRESH (regenerating from
 * the app tree reproduces the committed bytes) and NON-VACUOUS (`boxSlots` is non-empty
 * and equals a second, independent derivation from `boxSlots()`). If that test is ever
 * weakened this scan goes quiet WITHOUT failing — it would keep agreeing, accurately,
 * about a stale fixture. A guard whose other half lives in another repository is exactly
 * the kind that rots unnoticed, so it is written down here instead of assumed.
 *
 * The copy is refreshed as a named item of the CLI release lane (§37.5b).
 */

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PLAN_SKILL_DOC = "plugin/skills/plan/SKILL.md";
const CONTRACT_DOC = "fixtures/app-contract/mcp-tools.json";

const PLAN_SKILL = read(PLAN_SKILL_DOC);
const CONTRACT = JSON.parse(read(CONTRACT_DOC)) as { boxSlots: Array<{ name: string; docClass: string }> };
const SLOTS = CONTRACT.boxSlots;

/** Every table row whose first cell is nothing but one backticked token, as `{ name, docClass }`. */
const slotRows = (text: string): Array<{ name: string; docClass: string }> =>
  text
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5 && /^`[^`]+`$/.test(cells[1] ?? ""))
    .map((cells) => ({ name: cells[1].slice(1, -1), docClass: cells[2] }));

/**
 * Both sides get the SAME comparator, so equality does not depend on which one it is —
 * this is a set comparison wearing a sort. (The fixture's own bytes are ordered by code
 * point, per app-16's total rule; nothing here re-orders the file.)
 */
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

describe("the plan skill's slot table", () => {
  test("it is exactly the live template's box slots", () => {
    // Anti-vacuous: an empty slot list agrees with a skill whose table stopped parsing.
    expect(SLOTS.length).toBeGreaterThan(0);

    const fromSkill = slotRows(PLAN_SKILL);
    expect(fromSkill.length).toBe(SLOTS.length);

    expect([...fromSkill].sort(byName)).toEqual([...SLOTS].sort(byName));
  });

  /**
   * The scan's own control. A reader that silently stops parsing returns [], and
   * [] vs [] is the shape every vacuous scan takes — so each mutation asserts it
   * landed before asserting it was caught.
   */
  test("the slot scan detects the drift it exists for", () => {
    expect(slotRows(PLAN_SKILL).length).toBe(SLOTS.length);

    // A renamed slot in the skill.
    const renamed = PLAN_SKILL.replace("| `Release Notes` |", "| `Ship Notes` |");
    expect(renamed).not.toBe(PLAN_SKILL);
    expect(slotRows(renamed)).not.toEqual(slotRows(PLAN_SKILL));

    // A slot DELETED from the skill — the direction the previous guard missed.
    const dropped = PLAN_SKILL.split("\n").filter((l) => !l.includes("| `Retrospective` |")).join("\n");
    expect(slotRows(dropped).length).toBe(slotRows(PLAN_SKILL).length - 1);

    // A wrong class on an otherwise correct row.
    const misclassed = PLAN_SKILL.replace("| `Research/` | reference |", "| `Research/` | working |");
    expect(misclassed).not.toBe(PLAN_SKILL);
    expect(slotRows(misclassed)).not.toEqual(slotRows(PLAN_SKILL));

    // A table that stops being a table reads as empty, never as agreement.
    expect(slotRows("no table here")).toEqual([]);

    // And the same failure from the fixture's side, which is new here: the app read a
    // live template, this repository reads a copied key. A key that has gone missing or
    // gone empty also reads as [], which `toEqual` would call agreement — the
    // `length > 0` assertion above is what refuses it, and this is the proof it has
    // something to refuse.
    const dead = JSON.parse(read(CONTRACT_DOC)) as { boxSlots?: Array<{ name: string; docClass: string }> };
    dead.boxSlots = [];
    expect(dead.boxSlots.length > 0).toBe(false);
    expect(dead.boxSlots).toEqual(slotRows("no table here"));
    delete dead.boxSlots;
    expect(dead.boxSlots).toBeUndefined();
  });
});
