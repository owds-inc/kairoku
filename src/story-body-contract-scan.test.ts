import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The six-section story-body contract, and the guarantee that its two copies
 * agree about which sections exist and in what order.
 *
 * WHAT IT DEFENDS
 * ---------------
 * `plugin/agents/implementer.md` tells the executor what to READ; the section
 * order there is a reading protocol, and it has always been the de facto
 * contract. `plugin/skills/plan/SKILL.md` now tells the planner what to WRITE.
 * Two files, one shape — and nothing but this scan stops one of them moving.
 * The failure it catches is the quiet one: a section renamed or resequenced on
 * the writing side while every implementer keeps reading for the old order, so
 * stories keep passing review and keep arriving in an order nobody reads them
 * in.
 *
 * WHY BOTH LISTS ARE DERIVED
 * --------------------------
 * A literal `["Context", "Objective", …]` in this file would be a THIRD copy of
 * the contract, free to rot on its own and to agree with neither file. So both
 * ordered lists are extracted from the documents at test time and compared
 * against each other; this file asserts a relationship, never the content.
 *
 * The one asymmetry is deliberate. The implementer reads SEVEN things; the
 * seventh — test notes — is not a body section at all, it is the plan item's
 * own `testNotes` field, which is why writing it into the body leaves the
 * `Automated tests` subtask holding a placeholder. Its name is read out of the
 * skill rather than typed here, so even the exclusion is derived.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const IMPLEMENTER = "plugin/agents/implementer.md";
const SKILL = "plugin/skills/plan/SKILL.md";

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/** The text between two markers, or null when the opening marker is absent. */
function section(text: string, from: string, to: RegExp): string | null {
  const start = text.indexOf(from);
  if (start === -1) return null;
  const rest = text.slice(start + from.length);
  const end = rest.search(to);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The implementer's reading protocol, in the order it reads. */
function implementerProtocol(text: string): string[] | null {
  // Anchored on the distinctive middle of the sentence, not its opening: this repo's
  // canonical implementer writes it in bold — "**The item's six-section body is your entire
  // brief**" — where the app's copy writes it plain. The `**` is what a whole-sentence anchor
  // trips on, and the substring below is the part that carries the meaning either way.
  const block = section(text, "six-section body is your entire brief", /\nThen read/);
  if (block === null) return null;
  return [...block.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((match) => match[1]);
}

/** The skill's ordered list of body sections. */
function skillSections(text: string): string[] | null {
  const block = section(text, "### The shape of an item", /\n#{2,3} /);
  if (block === null) return null;
  return [...block.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((match) => match[1]);
}

/**
 * The name of the one thing the implementer reads that is NOT a body section,
 * taken from the sentence in the skill that says so.
 */
function fieldOnlySection(text: string): string | null {
  return /\*\*([^*]+) never go in the body\.\*\*/.exec(text)?.[1] ?? null;
}

/** The comparison itself, over text rather than paths, so drift can be simulated. */
function bodySectionsAgree(implementerText: string, skillText: string): boolean {
  const protocol = implementerProtocol(implementerText);
  const sections = skillSections(skillText);
  const fieldOnly = fieldOnlySection(skillText);
  if (!protocol || !sections || !fieldOnly) return false;
  const expected = protocol.filter((name) => name !== fieldOnly);
  return expected.length === sections.length && expected.every((name, i) => name === sections[i]);
}

describe("the six-section story-body contract", () => {
  const implementer = read(IMPLEMENTER);
  const skill = read(SKILL);

  test("both files were found and read non-empty", () => {
    // A scan over nothing passes for the wrong reason. Guards a moved plugin
    // tree, a renamed skill, and a `read` that silently returned "".
    expect(implementer.length, `${IMPLEMENTER} is empty`).toBeGreaterThan(1_000);
    expect(skill.length, `${SKILL} is empty`).toBeGreaterThan(1_000);
  });

  test("both ordered lists are actually extracted", () => {
    // `toBeNull` first and separately: a renamed heading must fail as "not
    // found" rather than as "two empty lists, therefore equal".
    const protocol = implementerProtocol(implementer);
    const sections = skillSections(skill);
    expect(protocol, `${IMPLEMENTER} has no reading protocol`).not.toBeNull();
    expect(sections, `${SKILL} has no ordered section list`).not.toBeNull();
    expect(sections!.length).toBe(6);
    // Seven: the six body sections plus the field-only one.
    expect(protocol!.length).toBe(sections!.length + 1);
    expect(fieldOnlySection(skill), `${SKILL} does not say which section is field-only`).not.toBeNull();
  });

  test("the skill writes the sections in the order the implementer reads them", () => {
    const protocol = implementerProtocol(implementer)!;
    const fieldOnly = fieldOnlySection(skill)!;
    expect(skillSections(skill)).toEqual(protocol.filter((name) => name !== fieldOnly));
  });

  test("the field-only section is one the implementer actually reads", () => {
    // Otherwise the exclusion would remove nothing and the lists could never
    // agree — or worse, would agree by dropping a real section.
    expect(implementerProtocol(implementer)).toContain(fieldOnlySection(skill)!);
  });

  test("the skill states the `Satisfies:` convention and the id shapes", () => {
    expect(skill).toContain("Satisfies:");
    expect(skill).toContain("Verifies:");
    expect(skill).toContain("`FR-###`");
    expect(skill).toContain("`SC-###`");
  });

  test("the skill states the append-only rule with its reason", () => {
    expect(skill).toContain("append-only");
    expect(skill).toContain("never renumbered and never reused");
    expect(skill).toContain("cannot be re-pointed");
  });

  test("the skill states what happens when test notes go in the body", () => {
    // The consequence, not just the rule: the subtask that ends up holding a
    // placeholder is the whole reason the rule exists.
    expect(skill).toContain("never go in the body");
    expect(skill).toContain("`Automated tests` subtask");
    expect(skill).toContain("placeholder");
  });

  test("the UI story template reads as an addendum to this shape, not a rival", () => {
    const template = read("plugin/skills/plan/ui-story-template.md");
    expect(template.length).toBeGreaterThan(1_000);
    expect(template).toContain("addendum, not a second template");
    expect(template).toContain("plugin/skills/plan/SKILL.md");
  });

  test("no live reference to the old docs/process location remains", () => {
    // Three of the four entries this list held app-side — `src/components/ui/design-tokens.test.tsx`,
    // `CLAUDE.md` and `AGENTS.md` — are app-repo files that do not exist here, and reading one
    // would throw ENOENT rather than check anything. What this repository owns is the plugin
    // tree, so the sweep is every markdown file under `plugin/`: wider than the single entry
    // that survived the move, and it needs no edit when a skill or an agent is added.
    // (The app keeps its own three until app-11b, which is what makes both halves covered.)
    const scanned = readdirSync(path.join(ROOT, "plugin"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.posix.join("plugin", file));
    expect(scanned.length).toBeGreaterThan(0);
    for (const file of scanned) {
      expect(read(file), file).not.toContain("docs/process");
    }
  });

  // Positive controls. A drift check that cannot detect drift is decoration.
  test("a reordered pair of sections is detected", () => {
    expect(bodySectionsAgree(implementer, skill)).toBe(true);

    const sections = skillSections(skill)!;
    const [first, second] = sections;
    const drifted = skill
      .replace(`1. **${first}**`, "1. **__SWAP__**")
      .replace(`2. **${second}**`, `2. **${first}**`)
      .replace("1. **__SWAP__**", `1. **${second}**`);
    expect(skillSections(drifted)).not.toEqual(sections);
    expect(bodySectionsAgree(implementer, drifted)).toBe(false);
  });

  test("a renamed section on the reading side is detected", () => {
    const renamed = implementer.replace(
      `- **${implementerProtocol(implementer)![0]}**`,
      "- **Background**",
    );
    expect(bodySectionsAgree(renamed, skill)).toBe(false);
  });

  test("a missing block is not mistaken for agreement", () => {
    // Two absent lists are both null and would compare equal; the extractors
    // return null so the comparison can refuse rather than pass.
    expect(implementerProtocol("# nothing here\n")).toBeNull();
    expect(skillSections("# nothing here\n")).toBeNull();
    expect(bodySectionsAgree("# nothing here\n", "# nothing here\n")).toBe(false);
  });
});
