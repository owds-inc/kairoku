import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The plugin skill's tool table against the wire schemas it describes.
 *
 * WHAT IT DEFENDS
 * ---------------
 * v2 shipped six optional arguments — `get_project.brief`, `search_documents.include`,
 * `get_plan.include_ledger`, `update_item_status.expected_status`,
 * `update_document.project`, `upsert_plan.base_updated_at` — and the table in
 * `plugin/skills/kairoku-mcp/SKILL.md` was not updated for any of them. Five of the six
 * appeared nowhere in `plugin/` at all, so the table was the only place an agent would
 * look and it said the arguments did not exist. `include_ledger` was separately found
 * unreachable over the wire, which is exactly the kind of defect undocumented capability
 * hides: nobody calls it, so nobody notices it is broken.
 *
 * Both sides are PARSED. The alternative — a hardcoded list of the six — is the same bug
 * one level up, and a seventh argument would sail straight past it.
 *
 * WHERE THE WIRE SIDE COMES FROM, SINCE THE MOVE (app-11a, DECISIONS §37.5b–e)
 * ---------------------------------------------------------------------------
 * This scan lives in the CLI repo now, where the plugin is canonical (§19.4). The two app
 * files it used to parse — `src/app/api/mcp/route.ts` and `src/lib/comms/mcp/wire-schemas.ts`
 * — do not exist here. The wire side arrives instead as `fixtures/app-contract/mcp-tools.json`,
 * a byte-for-byte copy of the app's `contracts/mcp-tools.json`, which the app generates with
 * `bun run export:mcp-contract` from the very parser this file used to hold: app-11a0 lifted
 * `wireArgs`/`wireItemArgs` verbatim into the app's `src/lib/comms/mcp/wire-shape.ts` so that
 * ONE parser feeds both the app-side scan and the export. The fixture is therefore what this
 * file used to compute, not a second reading of the same source.
 *
 * WHAT THE MOVE COSTS, SAID PLAINLY RATHER THAN LEFT TO BE REDISCOVERED.
 * The controls at the bottom still prove this scan's COMPARISON LOGIC detects drift — a grown
 * argument list, a grown or renamed item shape, a renamed heading, a doc that invents an
 * argument. They no longer prove the PARSER reads the wire correctly, because there is no wire
 * here to parse. That half now lives in the app, in `scripts/export-mcp-contract.test.ts`:
 * FRESH (regenerating from the app tree reproduces the committed bytes) and NON-VACUOUS (every
 * tool the route registers is present, and the item shape is not empty). If that test is ever
 * weakened, this scan goes quiet WITHOUT failing — it would keep agreeing, accurately, about a
 * stale fixture. A guard whose other half lives in another repository is exactly the kind that
 * rots unnoticed, so it is written down here instead of assumed.
 *
 * The copy is refreshed as a named item of the CLI release lane (§37.5b) — the one moment both
 * repositories are in one lane, so drift is caught at release time.
 *
 * SCOPE, AND THE DEPTH IT REACHES
 * -------------------------------
 *
 * Document side, in three bands of decreasing strength:
 *
 * 1. `plugin/skills/kairoku-mcp/SKILL.md`'s table — every registered tool, every TOP-LEVEL
 *    argument, names and optionality, in both directions.
 * 2. ONE nested object: `upsert_plan`'s item, which the table spells
 *    `{title, description?, test_notes?, needs_manual_check?, testNotes?, needsManualCheck?}`
 *    (app-10's dual spelling) — names AND optionality against the table, names
 *    only wherever another plugin doc restates it. **Depth stops here.** The guard reaches
 *    the schema's top level plus that single nested object, and nothing deeper: a phase's
 *    own `{name, description?, items}` is NOT covered even though
 *    `plugin/skills/plan/SKILL.md` now spells it out, because the table — the one document
 *    this file holds to the strict standard — does not describe it. That single-object
 *    depth is why `phases` reads as one required argument in band 1, which is deliberate,
 *    and why the top-level extraction drops nested shapes wholesale.
 * 3. Every other `plugin/**` markdown file — `plugin/skills/plan/SKILL.md`,
 *    `plugin/skills/next/SKILL.md`, `plugin/agents/implementer.md`, the rest. Backticked
 *    calls in these are checked ONE way only: they may not name an argument the wire does
 *    not have. That catches a rename or a removal on the wire leaving a document telling
 *    agents to send a field the server now rejects.
 *
 *    They are NOT checked for completeness or optionality, and that is an admitted gap
 *    rather than an oversight. Those files write illustrative calls that legitimately omit
 *    optional arguments — `create_document(project, title, type: "spec", content)` omits
 *    `format?` on purpose — and they carry no `?` marks at all, so a completeness check
 *    would fire on prose that is doing its job. The cost is real: a NEW optional argument
 *    can leave `plugin/skills/plan/SKILL.md` stale, which is the v2 regression itself, and
 *    only band 1 would catch it. Closing that needs those files to adopt the table's
 *    notation, not a cleverer parser here.
 *
 * NOT A SECOND PIN ON THE TOOL COUNT. The `11` below is sanity — proof that the fixture
 * arrived with something in it and that the table parser found something, rather than the two
 * agreeing about nothing. It carries MORE weight here than it did in the app: an empty tool map
 * agrees with every table, so this count is the only thing standing between a fixture that
 * failed to load and a green scan. Constraint 2's pin itself stays where it is, in the app's
 * `"exports exactly the eleven tools"` test.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/**
 * One documented-or-wired argument, and the two canonical forms of an argument list.
 *
 * These three lived in this file until app-11a0 lifted them into the app's
 * `src/lib/comms/mcp/wire-shape.ts` so the export script could share them. That module is
 * app-side, so they come home here — same bodies, same meanings. `Arg` is also the fixture's
 * element shape, which is not a coincidence: the fixture is `wireArgs`'s return value.
 */
type Arg = { name: string; optional: boolean };
const names = (args: Arg[]) => args.map((a) => a.name).sort();
/** Canonical `name?` form, order-independent — what "the same signature" means here. */
const sig = (args: Arg[]) => args.map((a) => `${a.name}${a.optional ? "?" : ""}`).sort().join(", ");

const TABLE_DOC = "plugin/skills/kairoku-mcp/SKILL.md";
const CONTRACT_DOC = "fixtures/app-contract/mcp-tools.json";
const SKILL = read(TABLE_DOC);

/** Every markdown file under `plugin/`, as `[repo-relative path, text]`. */
const PLUGIN_DOCS = readdirSync(path.join(ROOT, "plugin"), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".md"))
  .map((f) => [path.posix.join("plugin", f), read(path.join("plugin", f))] as const);

/** A backticked call: `` `get_plan(project, release?)` ``. */
const CALL = /`([a-z_]+)\(([^)]*)\)`/g;
/**
 * `upsert_plan`'s item shape as a document states it — "each item `{…}`" in the table, "an
 * item `{…}`" in `plugin/skills/plan/SKILL.md`.
 *
 * ponytail: coupled to that phrasing. A doc that rewords to "an item is `{…}`" drops out of
 * this band silently, which is why the anchor test below pins the TABLE's statement — the
 * one that reworded during this file's own writing was the other doc, and losing the table
 * fails loudly. Upgrade path if it churns: match every backticked `{…}` in the doc and
 * require each to equal a shape the wire has.
 */
const ITEM_SHAPE = /\bitem\s+`\{([^}]*)\}`/;

/**
 * One documented argument.
 *
 * Three decorations are not part of the name: `[]` is the table's array notation
 * (`phases[]`), `=…` documents a default (`format?=markdown` — plausible, since that row's
 * description already says markdown is the default), and `: …` is the other skills' form
 * for a call with a value in it (`type: "spec"`). Strip the value part BEFORE reading the
 * `?`, or `format?=markdown` parses as a required argument literally called
 * `format?=markdown`.
 *
 * ponytail: the list is split on commas, so a comma inside a value would read as a second
 * argument. `parseArgList` empties bracketed values first, which covers the array case; a
 * comma inside a QUOTED value would still mis-split — and fail loudly on the name it
 * invented, never silently. No call in `plugin/` has one.
 */
const parseArg = (raw: string): Arg => {
  const a = raw.replace(/\[\]/g, "").replace(/\s*[=:][\s\S]*$/, "").trim();
  return { name: a.replace(/\?$/, ""), optional: a.endsWith("?") };
};

const parseArgList = (list: string): Arg[] =>
  // Empty a bracketed value BEFORE splitting, so `include: ["document","message"]` — a
  // plausible way for another skill to show an array argument — is one argument rather
  // than two, the second of which would look like an invented name.
  list.replace(/\[[^\]]*\]/g, "[]").split(",").map((s) => s.trim()).filter(Boolean).map(parseArg);

/** The item shape one document states, parsed. Band 2 and its controls read it the same way. */
const statedItem = (text: string): Arg[] => parseArgList(text.match(ITEM_SHAPE)![1]);

/** Text from a heading up to the next heading at `level` or shallower. */
function section(text: string, heading: string, level: number): string | null {
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

type Documented = { args: Record<string, Arg[]>; conflicts: string[] };

/**
 * The tool signatures the skill's table documents.
 *
 * Returns null when the heading is gone, so a renamed section fails as "not found" rather
 * than as agreement — two empty results compare equal.
 */
function documentedArgs(skillText: string): Documented | null {
  const table = section(skillText, "## The tools, and what each is for", 2);
  if (table === null) return null;
  const args: Record<string, Arg[]> = {};
  const conflicts: string[] = [];
  // Table rows only: the section also carries four paragraphs of prose that name
  // `update_document` and `get_plan` in backticks. And only the FIRST cell, so a signature
  // mentioned in the right-hand description column is not mistaken for the row's subject.
  // The separator row `|---|---|` has no backticked call and drops out on its own.
  for (const line of table.split("\n").filter((l) => l.trimStart().startsWith("|"))) {
    for (const m of (line.split("|")[1] ?? "").matchAll(CALL)) {
      const parsed = parseArgList(m[2]);
      // A first cell legitimately holds two tools — `list_documents` / `get_document` — so a
      // second call is not itself an error. But assigning by name lets the LAST win, and a
      // row whose first cell also mentions some other tool would then silently replace that
      // tool's own row and report drift on a signature nobody touched. Keep the first, and
      // surface a DISAGREEMENT as its own finding.
      if (args[m[1]]) {
        if (sig(args[m[1]]) !== sig(parsed)) conflicts.push(m[1]);
        continue;
      }
      args[m[1]] = parsed;
    }
  }
  return { args, conflicts };
}

/**
 * The wire side, exactly as the app generated it. `tools` is `wireArgs`'s return value —
 * every registered tool with its TOP-LEVEL arguments — and `upsertPlanItem` is
 * `wireItemArgs`'s, the one nested object the documents describe. The export writes `[]`
 * rather than `null` for a failed item parse, so the emptiness guard below is what catches it.
 */
const CONTRACT = JSON.parse(read(CONTRACT_DOC)) as { tools: Record<string, Arg[]>; upsertPlanItem: Arg[] };
const wire = CONTRACT.tools;
const wireItem = CONTRACT.upsertPlanItem;
const documented = documentedArgs(SKILL);

describe("the skill's tool table matches the wire schemas", () => {
  test("both sides parsed at all", () => {
    // Anti-vacuous-pass guard: a scan over nothing agrees with a scan over nothing.
    expect(Object.keys(wire)).toHaveLength(11);
    expect(documented).not.toBeNull();
    expect(Object.keys(documented!.args)).toHaveLength(11);
    // `[]`, not `null`, is how a failed item parse reaches the fixture — see the export
    // script's comment. Emptiness is therefore the thing to refuse, not nullness.
    expect(wireItem.length).toBeGreaterThan(0);
  });

  test("no tool is documented twice with two different signatures", () => {
    expect(documented!.conflicts).toEqual([]);
  });

  test("the same tools, in both directions", () => {
    // A registered tool missing from the table is the drift. A documented tool that is not
    // registered is a fiction an agent will try to call.
    expect(Object.keys(documented!.args).sort()).toEqual(Object.keys(wire).sort());
  });

  // Sets, never order: the schema orders `create_document` as
  // `project, title, type, format, content` and the table as `…, content, format?`. That
  // divergence is real, harmless, and a test that failed on it would cry wolf on day one.
  test.each(Object.keys(wire))("%s takes the arguments the table says it does", (tool) => {
    expect(names(documented!.args[tool] ?? [])).toEqual(names(wire[tool]));
  });

  test.each(Object.keys(wire))("%s marks the same arguments optional", (tool) => {
    const doc = new Map((documented!.args[tool] ?? []).map((a) => [a.name, a.optional]));
    expect(wire[tool].map((a) => `${a.name}${a.optional ? "?" : ""}`)).toEqual(
      wire[tool].map((a) => `${a.name}${doc.get(a.name) ? "?" : ""}`),
    );
  });

  test("the prose still says eleven", () => {
    // Cheap, and the phrase is load-bearing vocabulary in both rules files: a twelfth
    // registration has to change the sentence too.
    expect(SKILL).toMatch(/\beleven tools\b/);
  });
});

describe("the item object nested inside upsert_plan", () => {
  /** Every plugin doc that spells the item shape out, and what it says. */
  const stated = PLUGIN_DOCS.filter(([, text]) => ITEM_SHAPE.test(text)).map(
    ([file, text]) => [file, statedItem(text)] as const,
  );

  test("the table still states the shape", () => {
    // Anti-vacuous: the checks below are a scan, and a scan over nothing passes.
    expect(stated.map(([file]) => file)).toContain(TABLE_DOC);
  });

  test("the table states it exactly — names and optionality", () => {
    expect(sig(stated.find(([file]) => file === TABLE_DOC)![1])).toBe(sig(wireItem));
  });

  // Names only for the rest, for band 3's reason: the other docs mark arrays `[]` and use
  // `?` unevenly (`plugin/skills/plan/SKILL.md` writes a phase's optional `items` as
  // `items[]`), so their `?` marks are not evidence of anything. A rename or an added field
  // — both of which leave a doc describing a payload the server rejects — still shows up.
  test.each(stated)("%s names the item fields the wire accepts", (_file, args) => {
    expect(names(args)).toEqual(names(wireItem));
  });
});

describe("no other plugin doc names an argument the wire does not have", () => {
  const calls = PLUGIN_DOCS.filter(([file]) => file !== TABLE_DOC).flatMap(([file, text]) =>
    [...text.matchAll(CALL)]
      .filter((m) => wire[m[1]]) // a backticked call that is not a registered tool is prose
      .map((m) => ({ file, tool: m[1], args: parseArgList(m[2]) })),
  );

  test("there are calls to check", () => {
    // Anti-vacuous again: `flatMap` over nothing produces a passing scan over nothing.
    expect(calls.length).toBeGreaterThan(0);
  });

  test("every argument named exists on the wire", () => {
    // Names only, one direction. See band 3 of the scope note for why omissions and
    // optionality are deliberately not checked here.
    const unknown = (c: (typeof calls)[number]) =>
      c.args.filter((a) => !wire[c.tool].some((w) => w.name === a.name)).map((a) => a.name);
    expect(calls.filter((c) => unknown(c).length > 0).map((c) => `${c.file}: ${c.tool} — ${unknown(c).join(", ")}`))
      .toEqual([]);
  });
});

/**
 * The scan's own controls. Without these there is no evidence it can still detect drift
 * after someone refactors it — this repo has shipped two scans that passed while checking
 * nothing.
 *
 * The DOCUMENT-side controls are unchanged by the move: the table parser still takes text, so
 * every one of those cases is a `.replace` on a copy. The WIRE-side controls used to mutate a
 * copy of `wire-schemas.ts` text; with no wire text in this repo they mutate a copy of the
 * PARSED FIXTURE instead — an added argument, an added or renamed item key. That is the same
 * question asked one step later in the pipeline: it proves the comparison catches the drift,
 * and no longer proves a parser produced the drift correctly. See the header for where that
 * second half lives now.
 *
 * Every control asserts its own mutation LANDED. A control whose replacement silently missed
 * compares a value against itself and passes, which is the exact failure mode the whole file
 * exists to prevent.
 */
describe("the scan detects the drift it exists for", () => {
  /**
   * Tools whose documented argument names differ from the wire's. `tools` is the wire side —
   * the fixture's `tools` map, or a mutated copy of it — and `s` the table's text. It used to
   * take the two app sources as text and parse them here; the parse happens in the app now, so
   * this takes its result and the `w` parameter is gone with it.
   */
  const mismatches = (tools: Record<string, Arg[]>, s: string) => {
    const d = documentedArgs(s);
    if (!d) return ["SECTION MISSING"];
    return Object.keys(tools).filter((t) => !d.args[t] || String(names(d.args[t])) !== String(names(tools[t])));
  };

  /**
   * A copy of the fixture's tool map with one extra argument on one tool — the wire-side
   * mutation, now made on the parsed object rather than on schema text. Proves the anchor
   * exists and that the growth landed, for the same reason `rewriteCall` does below.
   */
  const grow = (tools: Record<string, Arg[]>, tool: string, arg: Arg) => {
    expect(Object.keys(tools)).toContain(tool);
    const out = { ...tools, [tool]: [...tools[tool], arg] };
    expect(names(out[tool])).toContain(arg.name);
    expect(names(out[tool])).not.toEqual(names(tools[tool]));
    return out;
  };

  /**
   * What a deliberate breakage ADDS to the current picture. Measured as a delta so a
   * control about one tool does not also fail when a different tool really has drifted —
   * the tests above are what shout about that.
   */
  const base = mismatches(wire, SKILL);
  const added = (tools: Record<string, Arg[]>, s: string) => mismatches(tools, s).filter((t) => !base.includes(t));

  /**
   * Rewrite one documented signature, and prove the rewrite LANDED — that the anchor still
   * exists, and that the result really carries the signature the control claims to be
   * testing.
   *
   * Anchored on the call rather than on the row's current argument text, because a control
   * that quotes the whole signature breaks the day someone reorders or annotates that row —
   * which is a legitimate edit, and the control failing then would be the guard crying wolf
   * about its own test data.
   *
   * Landing is proved POSITIVELY — the result contains the signature the control names —
   * rather than as `!== skillText`. Same protection against a replacement that silently
   * missed, and it does not turn "the table already says this" into a failure: a control
   * whose premise the tree has since adopted is still checking the thing it claims to.
   */
  const rewriteCall = (skillText: string, tool: string, args: string) => {
    const anchor = new RegExp("`" + tool + "\\([^)]*\\)`");
    expect(skillText).toMatch(anchor);
    const out = skillText.replace(anchor, `\`${tool}(${args})\``);
    expect(out).toContain(`\`${tool}(${args})\``);
    return out;
  };

  /** Same, but leaves the call alone and drops a second one beside it. */
  const alsoMentions = (skillText: string, tool: string, extra: string) => {
    const anchor = new RegExp("`" + tool + "\\([^)]*\\)`");
    expect(skillText).toMatch(anchor);
    const out = skillText.replace(anchor, (m) => `${m} — see also \`${extra}\``);
    expect(out).toContain(`— see also \`${extra}\``);
    return out;
  };

  test("a table row that loses an argument is caught", () => {
    expect(added(wire, rewriteCall(SKILL, "get_plan", "project, release?"))).toEqual(["get_plan"]);
  });

  test("a table row that invents one is caught", () => {
    expect(added(wire, rewriteCall(SKILL, "get_document", "document_id, sort?"))).toEqual(["get_document"]);
  });

  test("a NEW wire argument with the doc untouched is caught — the v2 regression itself", () => {
    // Was: grow `getDocumentSchema` in a copy of `wire-schemas.ts`. Same argument, one step
    // later — the app grows a schema, the export carries the new argument into the fixture,
    // and the untouched table is what has to fail.
    expect(added(grow(wire, "get_document", { name: "limit", optional: true }), SKILL)).toEqual(["get_document"]);
  });

  test("a NEW argument on the NESTED item object is caught", () => {
    const grown = [...wireItem, { name: "owner", optional: true }];
    expect(names(grown)).not.toEqual(names(wireItem));
    // Invisible to the top-level scan by design — this is the depth band 2 exists for. The
    // fixture keeps the two sides in separate keys, which is the same depth-1 truncation
    // `wireArgs` performs; the top-level map cannot see an item key either way.
    expect(added(wire, SKILL)).toEqual([]);
    // Band 2 is what sees it: the table's stated shape stops matching.
    const table = sig(statedItem(SKILL));
    expect(table).toBe(sig(wireItem));
    expect(table).not.toBe(sig(grown));
  });

  test("a RENAMED nested field is caught — the doc would ask for a rejected key", () => {
    // `test_notes` -> `notes`. app-10 put BOTH spellings on the wire for one release, so the
    // rename this control simulates is the removal that ends that window with the documents
    // left behind — the exact shape that leaves every doc asking for a rejected key.
    const renamed = wireItem.map((a) => (a.name === "test_notes" ? { name: "notes", optional: a.optional } : a));
    expect(names(renamed)).not.toEqual(names(wireItem));
    expect(added(wire, SKILL)).toEqual([]);
    const table = sig(statedItem(SKILL));
    expect(table).toBe(sig(wireItem));
    expect(table).not.toBe(sig(renamed));
  });

  test("a renamed heading fails as 'section not found', not as agreement", () => {
    expect(documentedArgs(SKILL.replace("## The tools, and what each is for", "## Tools"))).toBeNull();
  });

  test("a fixture that arrived EMPTY cannot go green", () => {
    // The app-side version of this control mutated the parser's input so the parse produced
    // nothing, and proved that produced 0 tools rather than a silent agreement. Here the parse
    // happens in the app; what can arrive empty is the FIXTURE — a `tools: {}` from a broken
    // export, or a file that failed to load.
    //
    // The comparison cannot catch that, and this control's job is to prove it cannot: an empty
    // tool map has nothing to disagree with, so `mismatches` is empty and every `test.each`
    // above iterates zero times.
    expect(mismatches({}, SKILL)).toEqual([]);
    // Which is why the count and emptiness assertions in "both sides parsed at all" are the
    // load-bearing guards on this side of the move, and not decoration.
    expect(Object.keys(wire).length).toBeGreaterThan(0);
    expect(wireItem.length).toBeGreaterThan(0);
  });

  test("dropping a `?` is caught on optionality alone", () => {
    // W6B added `include_context_pack` to get_plan. This fixture is the real
    // list with ONE `?` removed — so it has to carry the new argument too, or
    // the name check above stops isolating the optionality half.
    const flattened = documentedArgs(
      rewriteCall(SKILL, "get_plan", "project, release?, include_ledger, include_context_pack?"),
    )!;
    // The NAME check still passes — this is the half only the optionality test sees.
    expect(names(flattened.args.get_plan)).toEqual(names(wire.get_plan));
    expect(flattened.args.get_plan.find((a) => a.name === "include_ledger")!.optional).toBe(false);
  });

  test("an argument another plugin doc invents is caught", () => {
    const unknown = (text: string) => {
      const call = [...text.matchAll(CALL)][0];
      return parseArgList(call[2]).filter((a) => !wire[call[1]].some((w) => w.name === a.name)).map((a) => a.name);
    };
    expect(unknown("Check with `get_plan(project, release, include_ledger, sort)` first.")).toEqual(["sort"]);
    // …and a bracketed example value is one argument, not a second invented one.
    expect(unknown('Try `search_documents(query, include: ["document", "message"])`.')).toEqual([]);
  });

  test("FALSE-POSITIVE CONTROL: reordering a row's arguments changes nothing", () => {
    // `get_plan`, NOT `create_document`. The comparison is a delta over what already
    // mismatches, and `create_document`'s documented order already diverges from the
    // schema's — so reordering THAT row is invisible to the delta, and this control would
    // pass even if the guard were made order-sensitive. Measured: dropping the `.sort()`
    // from `names` leaves a `create_document` reorder green and this one red.
    const reordered = rewriteCall(
      SKILL,
      "get_plan",
      // Same set as the wire, shuffled — W6B's `include_context_pack` included,
      // since a control for ORDER must not also be a control for membership.
      "include_context_pack?, include_ledger?, release?, project",
    );
    expect(added(wire, reordered)).toEqual([]);
    expect(sig(documentedArgs(reordered)!.args.get_plan)).toBe(sig(documented!.args.get_plan));
  });

  test("FALSE-POSITIVE CONTROL: rewording a description cell changes nothing", () => {
    const reworded = SKILL.replace("A milestone worth a line on the activity feed", "Anything worth telling a human");
    expect(reworded).not.toBe(SKILL);
    expect(added(wire, reworded)).toEqual([]);
  });

  test("FALSE-POSITIVE CONTROL: documenting a default (`format?=markdown`) changes nothing", () => {
    const defaulted = rewriteCall(
      SKILL,
      "create_document",
      "project, title, type, content, format?=markdown, folder?",
    );
    expect(added(wire, defaulted)).toEqual([]);
    expect(sig(documentedArgs(defaulted)!.args.create_document)).toBe(sig(documented!.args.create_document));
  });

  test("FALSE-POSITIVE CONTROL: a first cell naming a second tool does not overwrite its row", () => {
    const doubled = alsoMentions(
      SKILL,
      "add_progress_note",
      // An AGREEING second mention, so it must name every argument the wire has
      // — `include_context_pack?` as of W6B. One that omitted it would be the
      // disagreement the next test asserts, not the duplicate this one does.
      "get_plan(project, release?, include_ledger?, include_context_pack?)",
    );
    expect(added(wire, doubled)).toEqual([]);
    expect(documentedArgs(doubled)!.conflicts).toEqual([]);
  });

  test("but two mentions that DISAGREE are reported as a conflict, not as drift", () => {
    const contradicted = alsoMentions(SKILL, "add_progress_note", "get_plan(project)");
    expect(documentedArgs(contradicted)!.conflicts).toEqual(["get_plan"]);
    // And `get_plan`'s own row survives intact rather than being replaced by the mention.
    expect(added(wire, contradicted)).toEqual([]);
  });
});
