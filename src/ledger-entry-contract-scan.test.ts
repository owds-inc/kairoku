import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The ledger entry's wire shape, and the instruction that it is written before
 * the status it justifies.
 *
 * WHAT IT DEFENDS
 * ---------------
 * Entries are immutable by construction — `addProgressNote` writes `message`
 * verbatim and no tool on the server can delete a row — so a shape written
 * wrong is written wrong in every row that follows it. There is no migration
 * for a bad convention. This scan is the only thing standing between a
 * corrected shape and a silently divergent one.
 *
 * WHY A LITERAL SPEC HERE, WHEN `story-body-contract-scan` DERIVES BOTH SIDES
 * --------------------------------------------------------------------------
 * That scan compares two documents to each other and deliberately holds no
 * copy of its own, because either document may legitimately evolve. This one
 * is different in kind: it is a PIN, the same role `tools.test.ts` plays for
 * the eleven-tool surface. The wire shape is a promise made to every row
 * already written, so a change to it must be a deliberate edit to this file,
 * not something a documentation reword can carry along silently.
 *
 * The pin is still not the only assertion. The worked example is validated
 * against requirements PARSED OUT OF THE PROSE, so a doc that lists a field in
 * its requirements and omits it from the example fails even though the pin
 * itself is satisfied.
 *
 * WHAT DID NOT COME WITH IT (app-11a, DECISIONS §37.5b)
 * ----------------------------------------------------
 * The app-side copy of this file ended with one more block — a
 * `describe.skipIf(!process.env.DATABASE_URL)` that inserts a project, release, phase and
 * plan item, calls `addProgressNote` with a well-formed entry, and asserts the `plan_items`
 * row comes back byte-identical: the entry is a claim ABOUT the item, never a write to it.
 * That is a test of the SERVER, not of these documents. It needs `@/db`, `@/lib/comms/mcp/tools`
 * and a live Postgres, none of which exist in this repository, so it stayed in the app and is
 * the one part of this file that must NOT be deleted with the rest when the app drops its
 * plugin copy. Everything above it — the shape pin, the worked example, the ordering and
 * verification prose — reads only `plugin/**` and is here in full.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const SKILL = "plugin/skills/kairoku-mcp/SKILL.md";
const IMPLEMENTER = "plugin/agents/implementer.md";
const JIRA_OPS = "plugin/skills/jira-ops/SKILL.md";

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/** Text from a heading up to the next heading at `level` or shallower. */
function section(text: string, heading: string, level: number): string | null {
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

const ledgerSection = (text: string) => section(text, "## The ledger entry", 2);
const shapeBlock = (text: string) => section(text, "### The shape", 3);
const orderingBlock = (text: string) => section(text, "### Write the entry before the status", 3);

/**
 * One list bullet, INCLUDING its wrapped continuation lines.
 *
 * This exists because the obvious check is worthless. Asserting that the shape
 * block merely CONTAINS `skipped` passes on a document that names the field in
 * a prose aside three paragraphs below the requirements list — which teaches an
 * agent nothing about which claim requires it. Verified as a real hole: an
 * adversarial probe that deleted `skipped` from the requirements list left the
 * weaker assertion green, because a later paragraph still mentioned it.
 */
function bulletFor(block: string, claim: string): string | null {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^-\\s+\`${claim}\``).test(line.trim()));
  if (start === -1) return null;
  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A continuation is an indented, non-empty line. A new bullet or a blank
    // line ends this one.
    if (line.trim() === "" || /^-\s/.test(line.trim())) break;
    if (!/^\s+/.test(line)) break;
    collected.push(line);
  }
  return collected.join(" ");
}

/** Backticked identifiers named inside one bullet. */
function fieldsNamedIn(bullet: string, exclude: string): string[] {
  return [...bullet.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => n !== exclude);
}

/** The worked entry: the fenced line beginning with the sentinel. */
function workedExample(text: string): string | null {
  const match = text.match(/^ledger\/1 .*$/m);
  return match ? match[0] : null;
}

/**
 * THE PIN. Changing anything here changes a promise made to rows already
 * written — treat it as a plan amendment, never as a reword.
 */
const ALWAYS_REQUIRED = ["item", "claim"] as const;
const CLAIMS = ["built", "blocked", "verified", "refuted"] as const;
const REQUIRED_PER_CLAIM: Record<(typeof CLAIMS)[number], string[]> = {
  built: ["branch", "commits", "tests"],
  blocked: ["blocked_by"],
  verified: [],
  refuted: [],
};
const TESTS_KEYS = ["cmd", "passed", "failed", "skipped"] as const;

describe("the ledger entry contract", () => {
  // A scan over nothing passes for the wrong reason. Both files must exist and
  // carry content before any assertion below means anything.
  test("both documents are found and non-empty", () => {
    for (const file of [SKILL, IMPLEMENTER]) {
      const text = read(file);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(ledgerSection(read(SKILL))).not.toBeNull();
    expect(shapeBlock(read(SKILL))).not.toBeNull();
    expect(orderingBlock(read(SKILL))).not.toBeNull();
  });

  test("each claim's required fields are named ON THAT CLAIM'S OWN BULLET", () => {
    const block = shapeBlock(read(SKILL))!;

    for (const field of ALWAYS_REQUIRED) {
      expect(block).toContain(`\`${field}\``);
    }

    // Walked per claim, and scoped to the claim's own bullet. Asserting these
    // strings exist ANYWHERE in the block is the weaker check the item's test
    // notes call out by name, and an adversarial probe confirmed it: deleting
    // `skipped` from the requirements list left a block-wide `toContain` green,
    // because a later paragraph still mentioned the word.
    for (const claim of CLAIMS) {
      const bullet = bulletFor(block, claim);
      expect(bullet).not.toBeNull();
      for (const field of REQUIRED_PER_CLAIM[claim]) {
        expect(fieldsNamedIn(bullet!, claim)).toContain(field);
      }
    }

    // A test result is the command plus three separate integers, and all four
    // are stated where `tests` is required rather than somewhere nearby.
    const builtBullet = bulletFor(block, "built")!;
    for (const key of TESTS_KEYS) {
      expect(fieldsNamedIn(builtBullet, "built")).toContain(key);
    }
  });

  test("the entry is one line, sentinel first, with nothing before it", () => {
    const block = shapeBlock(read(SKILL))!;
    expect(block).toMatch(/one line/i);
    expect(block).toMatch(/nothing\s+\*{0,2}before the sentinel/i);

    const example = workedExample(block);
    expect(example).not.toBeNull();
    // The sentinel is at position zero of its own line, and the payload is one
    // JSON object on that same line.
    expect(example!.startsWith("ledger/1 ")).toBe(true);
    expect(example).not.toContain("\n");
    const payload = JSON.parse(example!.slice("ledger/1 ".length));
    expect(typeof payload).toBe("object");
  });

  test("the worked example is a valid `built` entry with a FULL object name", () => {
    const example = workedExample(shapeBlock(read(SKILL))!)!;
    const entry = JSON.parse(example.slice("ledger/1 ".length));

    expect(entry.claim).toBe("built");
    for (const field of [...ALWAYS_REQUIRED, ...REQUIRED_PER_CLAIM.built]) {
      expect(entry[field]).toBeDefined();
    }
    for (const key of TESTS_KEYS) {
      expect(entry.tests[key]).toBeDefined();
    }
    expect(typeof entry.tests.skipped).toBe("number");

    // An example is what an agent copies, so an abbreviated one teaches an
    // abbreviation — and the whole point of a full name is that a reader can
    // falsify the claim in one command.
    expect(Array.isArray(entry.commits)).toBe(true);
    expect(entry.commits.length).toBeGreaterThan(0);
    for (const sha of entry.commits) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("the example satisfies the requirements the PROSE states, not just the pin", () => {
    // Parsed out of the document: the bullet that begins with a claim name
    // names that claim's required fields in backticks. This catches a doc whose
    // requirements list and worked example have drifted apart, which the pin
    // alone cannot see.
    const block = shapeBlock(read(SKILL))!;
    const builtBullet = bulletFor(block, "built");
    expect(builtBullet).not.toBeNull();

    const stated = fieldsNamedIn(builtBullet!, "built");
    expect(stated.length).toBeGreaterThan(0);

    const entry = JSON.parse(workedExample(block)!.slice("ledger/1 ".length));
    for (const field of stated) {
      // `cmd`/`passed`/… live inside `tests`; everything else is top level.
      const present =
        entry[field] !== undefined ||
        (entry.tests !== undefined && entry.tests[field] !== undefined);
      expect(present).toBe(true);
    }
  });

  test("the ordering instruction names update_item_status and gives its reason alongside", () => {
    const block = orderingBlock(read(SKILL))!;
    // Asserted on the tool name and on the REASON, never on wording: this
    // sentence will be rewritten, and a wording pin fails on an improvement.
    expect(block).toContain("update_item_status");
    expect(block).toMatch(/before/i);
    expect(block).toMatch(/crash/i);
    // The reason has two halves and the entry is only worth ordering if both
    // are stated: what the good interleaving leaves behind, and what the bad
    // one does.
    expect(block).toMatch(/resum/i);
    expect(block).toMatch(/marked done with nothing behind it/i);

    // And it must not overclaim: nothing enforces this.
    expect(block).toMatch(/nothing enforces/i);
  });

  test("the implementer protocol routes the same facts to the ledger", () => {
    const text = read(IMPLEMENTER);
    expect(text).toContain("add_progress_note");
    expect(text).toContain("update_item_status");
    for (const field of ["claim", "commits", "branch", "tests", "blocked_by", "notes"]) {
      expect(text).toContain(field);
    }
    // The story key is NOT the entry's identifier; the plan item id is.
    expect(text).toMatch(/`item` is the plan item's own id/i);
  });

  test("the cadence rule still forbids one entry per commit", () => {
    // The ledger section sits beside the cadence rule and must not have
    // quietly licensed an entry per commit on its way in.
    expect(read(SKILL)).toMatch(/never per commit/i);
  });

  // NEGATIVE CONTROL. The entry's trustworthiness rests entirely on identity
  // coming from the row's credential column and time from its `created_at`. A
  // self-declared author or timestamp would make the entry a claim about
  // itself.
  test("the shape forbids self-declared identity and any date, duration or timestamp", () => {
    const block = shapeBlock(read(SKILL))!;
    const example = workedExample(block)!;
    const entry = JSON.parse(example.slice("ledger/1 ".length));

    for (const banned of [
      "agent",
      "author",
      "actor",
      "identity",
      "who",
      "date",
      "time",
      "timestamp",
      "started_at",
      "finished_at",
      "duration",
      "elapsed",
      "estimate",
    ]) {
      expect(Object.keys(entry)).not.toContain(banned);
    }

    // And the prose says so, so the absence is a rule rather than an accident
    // of one example.
    expect(block).toMatch(/forbidden/i);
    expect(block).toMatch(/identity/i);
    expect(block).toMatch(/timestamp/i);
  });

  // POSITIVE CONTROL: a drift check that cannot detect drift is decoration.
  test("the scan FAILS when the JSON is put before the sentinel", () => {
    const good = shapeBlock(read(SKILL))!;
    expect(workedExample(good)!.startsWith("ledger/1 ")).toBe(true);

    // A temporary copy with the two halves swapped — exactly the drift the
    // one-line rule exists to prevent.
    const drifted = good.replace(
      /^ledger\/1 (.*)$/m,
      (_match, payload: string) => `${payload} ledger/1`,
    );
    const example = workedExample(drifted);
    // Either no sentinel-led line survives, or it no longer leads its line.
    expect(example === null || !example.startsWith("ledger/1 ")).toBe(true);
  });

  // The cheapest wrong fix available here is to REPLACE the Jira evidence
  // comment with a ledger entry rather than to add one beside it. They serve
  // different readers and neither substitutes for the other.
  test("the jira-ops evidence comment is untouched by this work", () => {
    const text = read(JIRA_OPS);
    expect(text).toContain("[agent] Automated tests green.");
    expect(text).toContain("Ran: <the exact command> → <N passed, 0 failed>");
    expect(text).toContain("Covers: <the behaviours from the story's Test notes, in a line or two>");
    expect(text).toContain("Commit: <sha> on <branch>");
    expect(text).not.toContain("ledger/1");
  });
});

const verificationBlock = (text: string) => section(text, "### Checking someone else's claim", 3);

/** The paragraph of a block matching `probe`. Paragraphs are blank-line separated. */
function paragraphOf(block: string, probe: RegExp): string | null {
  return block.split(/\n{2,}/).find((p) => probe.test(p)) ?? null;
}

/**
 * The shared-credential caveat, as a REGION rather than a string match.
 *
 * Anchored on the one-token case because that is the concrete half — the half
 * an editor keeps when compressing — and the region runs to the end of the
 * section so the trigger that would justify deleting it is inside what gets
 * checked.
 */
function caveatRegion(block: string): string | null {
  const paragraphs = block.split(/\n{2,}/);
  const start = paragraphs.findIndex((p) => /mcp\.json/.test(p) && /\bone token\b/i.test(p));
  return start === -1 ? null : paragraphs.slice(start).join("\n\n");
}

/**
 * Every assertion the caveat must satisfy, as a callable — so the positive
 * control can run the REAL checks against a mutated copy instead of running a
 * weaker restatement of them and calling that a control.
 */
function assertCaveat(block: string | null): void {
  expect(block).not.toBeNull();
  const region = caveatRegion(block!);
  expect(region).not.toBeNull();

  // The concrete case, not an abstraction about identity.
  expect(region!).toMatch(/mcp\.json/);
  expect(region!).toMatch(/\bone token\b/i);
  // What goes wrong: the verifier and the claimant are one identity.
  expect(region!).toMatch(/credential/i);
  expect(region!).toMatch(/indistinguishable/i);
  // What a reader DOES about it — the operative half, and the one a summary drops.
  expect(region!).toMatch(/treats every identity within one run as one identity/i);
  // Where the fix lives, so it reads as a gap someone owns.
  expect(region!).toMatch(/per-agent/i);
  expect(region!).toMatch(/harness spec/i);
  // And the trigger, so a later reader can close it instead of deleting it as stale.
  expect(region!).toMatch(/trigger/i);
}

describe("checking someone else's claim", () => {
  test("the verification section is found and non-empty", () => {
    const text = read(SKILL);
    expect(text.length).toBeGreaterThan(0);
    const block = verificationBlock(text);
    expect(block).not.toBeNull();
    expect(block!.trim().length).toBeGreaterThan(0);
  });

  test("a verification is a ledger entry claiming `verified` or `refuted`", () => {
    const block = verificationBlock(read(SKILL))!;
    for (const claim of ["verified", "refuted"] as const) {
      expect(block).toContain(`\`${claim}\``);
      // Already pinned above as requiring nothing beyond the always-required
      // pair; asserted here so the two sections cannot drift apart.
      expect(REQUIRED_PER_CLAIM[claim]).toEqual([]);
    }
    expect(block).toContain("`item`");
  });

  test("the restate-rather-than-reference rule states its reason ALONGSIDE it", () => {
    const block = verificationBlock(read(SKILL))!;
    const rule = paragraphOf(block, /\brestates?\b/i);
    expect(rule).not.toBeNull();
    expect(rule!).toMatch(/observed/i);

    // The reason, in the same paragraph as the rule. Asserted separately from
    // the rule because a rule with no reason is the first thing an editor
    // compresses away, and the reason here is the whole of why it is not a
    // link: the write tool hands back nothing to link to.
    expect(rule!).toContain("add_progress_note");
    expect(rule!).toMatch(/row id/i);
  });

  test("a refuted entry leaves its target standing, and a correction is a new entry", () => {
    const block = verificationBlock(read(SKILL))!;

    const refutation = paragraphOf(block, /\bstanding\b/i);
    expect(refutation).not.toBeNull();
    expect(refutation!).toMatch(/refut/i);
    expect(refutation!).toMatch(/supersede/i);

    // A correction is a new entry, and the reason is the store's shape rather
    // than anyone's restraint — `activity_log` has no update path.
    const correction = paragraphOf(block, /correction is a new entry/i);
    expect(correction).not.toBeNull();
    expect(correction!).toMatch(/activity_log/);
    expect(correction!).toMatch(/no update path/i);
  });

  test("converge's findings are named as claims under the same rules", () => {
    const block = verificationBlock(read(SKILL))!;
    const converge = paragraphOf(block, /converge/i);
    expect(converge).not.toBeNull();
    expect(converge!).toMatch(/claim/i);
    expect(converge!).toMatch(/credential/i);
  });

  test("the shared-credential caveat is present, complete, and carries its trigger", () => {
    assertCaveat(verificationBlock(read(SKILL)));
  });

  // POSITIVE CONTROL, and the reason this item exists. The caveat is the
  // paragraph a later editor is most likely to drop as a digression, and a
  // verification protocol without it reads as though `verified` always means an
  // independent check. A check that cannot detect its loss is decoration — so
  // delete it in a copy and require the real assertions to fail.
  test("the scan FAILS when the shared-credential caveat is deleted", () => {
    const block = verificationBlock(read(SKILL))!;
    const paragraphs = block.split(/\n{2,}/);
    const at = paragraphs.findIndex((p) => /mcp\.json/.test(p) && /\bone token\b/i.test(p));
    expect(at).toBeGreaterThan(-1);

    const withoutCaveat = [...paragraphs.slice(0, at), ...paragraphs.slice(at + 1)].join("\n\n");
    expect(() => assertCaveat(withoutCaveat)).toThrow();
  });

  // NEGATIVE CONTROL. `add_progress_note` returns no row id, so an instruction
  // to link an entry to the one it disputes would be unfollowable — a writer
  // has nothing to put in the field. The section must never grow one.
  test("the section never instructs a writer to reference a prior entry by id", () => {
    const block = verificationBlock(read(SKILL))!;
    for (const forbidden of [
      /`entry_id`/,
      /`note_id`/,
      /`refutes`/,
      /`supersedes`/,
      /`parent`/,
      /`ref`/,
      /\bby its id\b/i,
      /reference (?:it|that entry|the entry|the prior entry|the previous entry) by\b/i,
      /\bid of the (?:prior|previous|original|disputed) entry\b/i,
    ]) {
      expect(block).not.toMatch(forbidden);
    }
  });

  test("the worked verification entry is one line and restates what was observed", () => {
    const block = verificationBlock(read(SKILL))!;
    const example = workedExample(block);
    expect(example).not.toBeNull();
    expect(example!.startsWith("ledger/1 ")).toBe(true);
    expect(example).not.toContain("\n");

    const entry = JSON.parse(example!.slice("ledger/1 ".length));
    expect(ALWAYS_REQUIRED.every((field) => entry[field] !== undefined)).toBe(true);
    expect(["verified", "refuted"]).toContain(entry.claim);

    // The example is what an agent copies. An example whose `notes` say
    // nothing teaches an entry that proves nothing, so it carries the values
    // it observed rather than a verdict.
    expect(typeof entry.notes).toBe("string");
    expect(entry.notes.length).toBeGreaterThan(40);

    // And it points at no other entry — there is no id it could point with.
    for (const banned of ["entry_id", "note_id", "refutes", "supersedes", "parent", "ref"]) {
      expect(Object.keys(entry)).not.toContain(banned);
    }
  });
});
