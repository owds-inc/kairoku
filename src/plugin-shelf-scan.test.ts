import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * KAIR-546 — FR-085. The plugin skill's document-tree section against the
 * `doc_class` enum it describes.
 *
 * WHAT IT DEFENDS
 * ---------------
 * The server has refused writes by document class at all four write seams since
 * FR-067 landed. `plugin/skills/kairoku-mcp/SKILL.md` mentioned the classes,
 * amendment filing and `Unsorted/` exactly zero times, so every agent running in
 * Codex or auggie met those refusals as surprises — the rule existed only in the
 * guard and in the refusal text an agent reads *after* it has already failed.
 *
 * The section this file guards is the fix. This file guards it against the way it
 * will rot: a fifth `doc_class` value, or a rename of one of the four, shipping
 * without the skill being told. That is a silent failure in both directions — the
 * skill keeps describing a class the enum no longer has, or stays quiet about one
 * it just gained — and neither shows up anywhere else in the suite.
 *
 * NOT HARDCODED. The four names are read out of the app's exported contract at test
 * time — `fixtures/app-contract/mcp-tools.json`, key `docClasses` — and out of the
 * skill's own table, and compared as sets. A test that spelled the four out would
 * agree with a stale skill about a stale enum, which is the same bug one level up.
 *
 * WHERE THE CLASS LIST COMES FROM, SINCE THE MOVE (cli-2, DECISIONS §37.5f / §44.1)
 * --------------------------------------------------------------------------------
 * This scan lives in the CLI repo now, where the plugin is canonical (§19.4). The app
 * file it used to parse — `src/db/schema.ts`, holding
 * `pgEnum("doc_class", [...])` — does not exist here, which is why app-11a moved six
 * sibling scans and honestly refused to move this one. app-16 removed the objection:
 * the app's `scripts/export-mcp-contract.ts` now IMPORTS `docClassEnum.enumValues` and
 * emits it as a top-level `docClasses` key, so the text parser this file used to hold
 * (`schemaClasses()`) is deleted rather than ported — there is no schema text here to
 * parse, and a second parser is a second thing to drift. The list arrives sorted code
 * point, which is what `tableClasses()` sorts to as well, so no second sort is needed.
 *
 * WHAT THE MOVE COSTS, SAID PLAINLY RATHER THAN LEFT TO BE REDISCOVERED.
 * The controls at the bottom still prove this scan's COMPARISON detects drift — a
 * renamed class in the skill, a grown enum, a section heading that stops parsing. They
 * no longer prove anything about how the enum is READ, because nothing here reads it;
 * that half lives in the app, in `scripts/export-mcp-contract.test.ts`, whose currency
 * test is FRESH (regenerating from the app tree reproduces the committed bytes) and
 * NON-VACUOUS (`docClasses` is present and not empty). If that test is ever weakened
 * this scan goes quiet WITHOUT failing — it would keep agreeing, accurately, about a
 * stale fixture. A guard whose other half lives in another repository is exactly the
 * kind that rots unnoticed, so it is written down here instead of assumed.
 *
 * The copy is refreshed as a named item of the CLI release lane (§37.5b).
 *
 * SCOPE. Tokens only — the four class names, the `Amendment — ` title prefix,
 * `Unsorted/`, and one negative control on the FR-098 create/edit split. Prose
 * wording is deliberately not asserted: the section is meant to be improved, and
 * a guard that failed on a better sentence would be deleted rather than obeyed.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const SKILL_DOC = "plugin/skills/kairoku-mcp/SKILL.md";
const CONTRACT_DOC = "fixtures/app-contract/mcp-tools.json";
const SKILL = read(SKILL_DOC);
const CONTRACT = JSON.parse(read(CONTRACT_DOC)) as { docClasses: string[] };

const SECTION_HEADING = "## The document tree and who writes what";

/** Text from the section heading up to the next `#`/`##` heading. */
function section(text: string): string | null {
  const start = text.indexOf(SECTION_HEADING);
  if (start === -1) return null;
  const rest = text.slice(start + SECTION_HEADING.length);
  const next = rest.search(/\n#{1,2} /);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The class names the section's own table documents: the first cell of every row
 * that is nothing but one backticked lowercase token. The header (`Class`) and the
 * `|---|` separator carry no backticks and drop out on their own, and a row whose
 * first cell is prose is not a class row.
 */
function tableClasses(text: string): string[] {
  const body = section(text);
  if (body === null) return [];
  return body
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => /^\s*`([a-z_]+)`\s*$/.exec(line.split("|")[1] ?? "")?.[1])
    .filter((slug): slug is string => slug !== undefined)
    .sort();
}

/** The row of the class table whose first cell names `docClass`. */
function classRow(text: string, docClass: string): string | undefined {
  return (section(text) ?? "")
    .split("\n")
    .find((line) => /^\s*`([a-z_]+)`\s*$/.exec(line.split("|")[1] ?? "")?.[1] === docClass);
}

const ENUM_CLASSES = CONTRACT.docClasses;

describe("the kairoku-mcp skill teaches the document tree", () => {
  test("it names every class, the amendment prefix, and Unsorted/", () => {
    // Anti-vacuous: a scan over an empty enum agrees with a skill that says nothing.
    expect(ENUM_CLASSES.length).toBeGreaterThan(0);
    // Scoped to the SECTION, not the file. Three of the four class words already
    // occur in unrelated prose here — `ledger` in the tool table and the ledger-entry
    // section, `reference` in create_document's row, `working` in "a person working in
    // the app" — so a whole-file scan passed for three classes no matter what this
    // section said, and only `living` ever actually depended on the story.
    const body = section(SKILL);
    expect(body).not.toBeNull();
    for (const docClass of ENUM_CLASSES) {
      expect(body!).toMatch(new RegExp(`\\b${docClass}\\b`));
    }
    // The em dash and the spaces either side are the routing convention itself
    // (`AMENDMENT_PREFIX` in `src/lib/template/routing.ts`), not typography.
    expect(SKILL).toContain("Amendment — ");
    expect(SKILL).toContain("Unsorted/");
  });

  test("the classes it documents are EXACTLY the doc_class enum's", () => {
    // The drift guard. A fifth class, or a rename, has to reach the skill — in
    // both directions, since a skill describing a class the enum dropped is as
    // wrong as one silent about a class it gained.
    expect(tableClasses(SKILL)).toEqual(ENUM_CLASSES);
  });

  test("it does not claim `reference` refuses creates — FR-098 amended that", () => {
    // The spec's original text said reference refused every actor every write.
    // FR-098 amended it: `assertDocumentWritable` refuses `update`/`move`/`delete`
    // and ALLOWS `create`, because the class's own supersession path requires
    // creating the superseding document. A section written from the superseded
    // prose would teach agents to give up on a call the server accepts.
    const row = classRow(SKILL, "reference");
    expect(row).toBeDefined();
    // Assert the PERMISSION, not the token. The previous form matched /creat\w*/
    // anywhere in the row, so "Creating is refused too — supersede it" satisfied the
    // one test written to catch exactly that superseded claim.
    // Scoped to the FIRST SENTENCE of the "what an agent may do" cell, because
    // that is where the create verdict lives. A whole-row negative match is wrong
    // in the other direction: the correct row legitimately says "Create a new
    // document. Update, move and delete all refuse", and a naive
    // create-near-refusal pattern fires on that perfectly accurate text.
    const agentCell = row!.split("|")[3] ?? "";
    const verdict = agentCell.split(".")[0];
    expect(verdict).toMatch(/creat\w*/i);
    expect(verdict).not.toMatch(/refus\w*|cannot|never|denied/i);
    // Sentence-scoped, so an accurate "refuses every edit" elsewhere in the row
    // cannot trip it — only a refusal and a create in the same breath can.
    expect(SKILL).not.toMatch(/reference[^.\n]{0,160}refus\w*[^.\n]{0,160}creat\w*/i);
    expect(SKILL).not.toMatch(/creat\w*[^.\n]{0,160}refus\w*[^.\n]{0,160}reference/i);
  });
});

/**
 * The scan's own control. Both readers take text, so drift is simulated with a
 * `.replace` on a copy — and every mutation asserts it LANDED, because a
 * replacement that silently missed compares a value against itself and passes.
 */
describe("the scan detects the drift it exists for", () => {
  test("a renamed class in the skill, or a new one in the enum, is caught", () => {
    const renamed = SKILL.replace(`| \`${ENUM_CLASSES[0]}\` |`, "| `legacy` |");
    expect(renamed).not.toBe(SKILL);
    expect(tableClasses(renamed)).not.toEqual(ENUM_CLASSES);

    // The enum arrives as a list, not as text, so a fifth class is a mutation of a
    // COPY of that list rather than a `.replace` on a schema file. The mutation still
    // asserts it landed first: a "grown" list that silently equalled the original
    // would compare a value against itself and pass.
    const grown = [...ENUM_CLASSES, "archive"].sort();
    expect(grown).not.toEqual(ENUM_CLASSES);
    expect(grown).toContain("archive");
    expect(tableClasses(SKILL)).not.toEqual(grown);
  });

  test("a fixture that has stopped saying anything cannot go green", () => {
    // A renamed heading fails as "section not found" rather than as agreement:
    // two empty sets compare equal, which is exactly how a scan passes over nothing.
    // Pin the LIVE case first, or every assertion below is empty-vs-empty and the
    // whole control goes green against a story that was reverted wholesale.
    expect(section(SKILL)).not.toBeNull();
    expect(tableClasses(SKILL).length).toBe(ENUM_CLASSES.length);
    expect(section(SKILL.replace(SECTION_HEADING, "## Documents"))).toBeNull();
    expect(tableClasses(SKILL.replace(SECTION_HEADING, "## Documents"))).toEqual([]);
    // The app-side half of this control guarded a TEXT PARSER: rename the pgEnum and
    // `schemaClasses()` returned [], which compares equal to the [] a broken section
    // reader returns — agreement over nothing. There is no parser here. The equivalent
    // failure is the fixture that has stopped carrying the key at all, or carries it
    // empty, and it takes the same shape: [] on one side, [] on the other, green.
    const absent = JSON.parse(read(CONTRACT_DOC)) as { docClasses?: string[] };
    delete absent.docClasses;
    expect(absent.docClasses).toBeUndefined();
    const emptied = JSON.parse(read(CONTRACT_DOC)) as { docClasses: string[] };
    emptied.docClasses = [];
    expect(emptied.docClasses).not.toEqual(ENUM_CLASSES);

    // Both read as [], and [] is exactly what `tableClasses` returns over a section
    // that no longer parses — so `toEqual` alone would call that AGREEMENT and pass.
    const brokenSection = tableClasses(SKILL.replace(SECTION_HEADING, "## Documents"));
    expect(brokenSection).toEqual(absent.docClasses ?? []);
    expect(brokenSection).toEqual(emptied.docClasses);

    // What refuses it is the non-vacuity assertion in the first test, and this is the
    // proof it has something to refuse: on the live fixture the predicate holds, and on
    // either dead one it does not. app-16 proved the same assertion discriminating one
    // repo over — a fixture regenerated from an emptied enum is honestly FRESH, so
    // freshness can never cover vacuity.
    expect(ENUM_CLASSES.length > 0).toBe(true);
    expect((absent.docClasses ?? []).length > 0).toBe(false);
    expect(emptied.docClasses.length > 0).toBe(false);
  });
});
