import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The lint scan for the plugin skills added in the incl-baseline release's
 * "Custom AI Functions" phase — `continuity` and `intake`, one file rather than
 * one per skill, because every check below is the same shape.
 *
 * WHAT IT DEFENDS
 * ---------------
 * A skill's prose is never exercised by anything else in this suite: it is read
 * by a model at runtime, in someone else's session, and a regression in it stays
 * invisible here until an agent misbehaves in front of a user. Three things are
 * load-bearing enough to guard:
 *
 * 1. The frontmatter. A malformed or missing key does not error — the client
 *    silently stops offering the skill, or offers it in the wrong mode.
 * 2. The tool names the body quotes. The MCP surface is pinned at eleven tools
 *    (`src/lib/comms/mcp/tools.test.ts`, "exports exactly the eleven tools"). A skill
 *    naming a twelfth teaches an agent to call something that does not exist,
 *    and a renamed export leaves the skill quoting a dead name.
 * 3. The prohibitions that are the point of each skill — for continuity: never
 *    recording a test run without its three counts (invariant 7), and staying
 *    off `/kairoku:wrap`'s ground so the model never fires both for one moment.
 *    For intake: never minting a stub plan item (invariant 3), never writing to
 *    Jira or claiming it did (invariant 1), and never filing into `Unsorted/`.
 *    These are the checks worth the most here — a skill that quietly loses a
 *    prohibition still reads fine and behaves wrongly only in someone's session.
 *
 * NOT HARDCODED. The tool names are read out of `fixtures/app-contract/mcp-tools.json` at
 * test time, not spelled out here — a list written down twice agrees with itself about
 * a stale surface, which is the same bug one level up. That fixture is a copy of the app's
 * `contracts/mcp-tools.json`, generated there from the schemas the MCP endpoint serves and
 * held current by the app's own currency test. Before app-11a moved this scan here the names
 * came straight out of `src/lib/comms/mcp/tools.ts`, which is an app-repo file and does not
 * exist in this repository. This file also does NOT
 * restate the pin: it asserts every name a skill quotes is IN the exported set,
 * never how many names that set holds. The count is the pin test's job and
 * belongs in exactly one place.
 *
 * SCOPE. Tokens and structure only. Prose wording is deliberately not asserted:
 * these skills are meant to be improved, and a guard that failed on a better
 * sentence would be deleted rather than obeyed.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const CONTINUITY = read("plugin/skills/continuity/SKILL.md");
const INTAKE = read("plugin/skills/intake/SKILL.md");
const PLAN = read("plugin/skills/plan/SKILL.md");

/**
 * The frontmatter block's keys and raw values. Not a YAML parser — the skills'
 * frontmatter is flat `key: value` by construction, and every other SKILL.md in
 * `plugin/skills/` is the same shape.
 */
function frontmatter(text: string): Record<string, string> | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** The body: everything after the frontmatter block. */
function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/**
 * The MCP tools, read out of the app's exported contract fixture.
 *
 * Its `tools` keys ARE the wire names — the `registerTool("…")` arguments in the app's
 * `src/app/api/mcp/route.ts` — so the camelCase-to-snake_case conversion the app-side version
 * performed on `tools.ts`'s exported function names is not merely unnecessary here, it would
 * be wrong: there are no function names to convert. The guard test below is what proves this
 * read found a real list rather than quietly returning an empty set.
 */
function exportedToolNames(): Set<string> {
  const contract = JSON.parse(read("fixtures/app-contract/mcp-tools.json")) as {
    tools: Record<string, unknown>;
  };
  return new Set(Object.keys(contract.tools));
}

/**
 * Tool-shaped tokens a skill body quotes: verb-prefixed snake_case, which is how
 * every tool on this surface is named. Anchoring on the verb prefix keeps the
 * field and type names that share the casing — `agent_prompt`, `base_updated_at`,
 * `include_ledger`, `document_id` — out of the match.
 */
function quotedToolNames(text: string): string[] {
  const tokens = text.matchAll(/\b(?:add|create|get|list|search|update|upsert)_[a-z0-9_]+\b/g);
  return [...new Set([...tokens].map((m) => m[0]))].sort();
}

const TOOLS = exportedToolNames();

describe("plugin skill lint — the scan's own inputs", () => {
  test("a real export list comes out of tools.ts", () => {
    // Guards the regex above rather than the surface: an extraction that quietly
    // matched nothing would make every cross-check below vacuously pass.
    expect(TOOLS.has("create_document")).toBe(true);
    expect(TOOLS.has("upsert_plan")).toBe(true);
  });
});

describe("plugin skill lint — continuity frontmatter", () => {
  test("name, description, user-invocable, and model invocation LEFT ON", () => {
    const fm = frontmatter(CONTINUITY);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("continuity");
    expect(fm!.description.length).toBeGreaterThan(0);
    expect(fm!["user-invocable"]).toBe("true");
    // Deliberate, and the opposite of `wrap`: the model has to be able to offer
    // continuity itself when context runs low, which is the moment the user is
    // least likely to think of typing the command.
    expect(fm).not.toHaveProperty("disable-model-invocation");
  });
});

describe("plugin skill lint — continuity body", () => {
  test("quotes only tools that exist on the eleven-tool surface", () => {
    const quoted = quotedToolNames(body(CONTINUITY));
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.filter((name) => !TOOLS.has(name))).toEqual([]);
  });

  test("names the tools its flow depends on", () => {
    for (const tool of [
      "list_documents",
      "update_document",
      "create_document",
      "get_document",
      "get_plan",
    ]) {
      expect(CONTINUITY).toContain(tool);
    }
  });

  test("one document per release: the agent_prompt type and the exact title pattern", () => {
    expect(CONTINUITY).toContain("agent_prompt");
    expect(CONTINUITY).toContain("Continuity — ");
  });

  test("list-then-update — a second run must not create a sibling", () => {
    // `create_document` has no dedupe and nothing on the surface can delete, so
    // the ordering is the whole defence against an unclearable fan of documents.
    // Compared on the CALL forms, not the bare names: the paragraph explaining
    // why lists `create_document` first, and prose order is not flow order.
    const list = CONTINUITY.indexOf("list_documents(project");
    const create = CONTINUITY.indexOf("create_document(project");
    expect(list).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(list).toBeLessThan(create);
  });

  test("a test result carries all three counts — never 'green' (invariant 7)", () => {
    expect(CONTINUITY).toMatch(/passed[\s\S]{0,60}failed[\s\S]{0,60}skipped/i);
  });

  test("the resume prompt starts the next session with get_document", () => {
    expect(CONTINUITY).toMatch(/First:\s*get_document/);
  });

  test("hands closeout to /kairoku:wrap and writes no progress note itself", () => {
    expect(CONTINUITY).toContain("/kairoku:wrap");
    expect(CONTINUITY).toMatch(/no\s+progress\s+note/i);
  });

  test("falls back to inline state when the app is signed out", () => {
    expect(CONTINUITY).toMatch(/signed out/i);
    expect(CONTINUITY).toMatch(/inline/i);
  });
});

/**
 * `plan` is edited from the app side too — the AI Workspace's `Draft release
 * plan` preset ends by telling the user to apply the draft with `/kairoku:plan`,
 * so the skill is now the other half of a flow that starts in the browser. The
 * frontmatter check is here because an edit to step 1 sits three lines under it,
 * and a slipped `---` fence is silent: the client stops offering the skill and
 * the preset's closing instruction points at a command that no longer resolves.
 */
describe("plugin skill lint — plan", () => {
  test("frontmatter survives: name, description, user-invocable", () => {
    const fm = frontmatter(PLAN);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("plan");
    expect(fm!.description.length).toBeGreaterThan(0);
    expect(fm!["user-invocable"]).toBe("true");
  });

  test("quotes only tools that exist on the eleven-tool surface", () => {
    const quoted = quotedToolNames(body(PLAN));
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.filter((name) => !TOOLS.has(name))).toEqual([]);
  });

  test("step 1 reads the direction documents before the interview", () => {
    // The interview is cheaper and better when it starts from what the project
    // has already decided; without this the agent asks the user to restate
    // their own Vision back to them.
    const absorb = PLAN.indexOf("Absorb what exists");
    const interview = PLAN.indexOf("Interview — one question at a time");
    const vision = PLAN.indexOf("Vision");
    expect(absorb).toBeGreaterThan(-1);
    expect(vision).toBeGreaterThan(absorb);
    expect(vision).toBeLessThan(interview);
    expect(PLAN).toContain("Roadmap");
  });
});

describe("plugin skill lint — intake frontmatter", () => {
  test("name, description, user-invocable, and an argument hint", () => {
    const fm = frontmatter(INTAKE);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe("intake");
    expect(fm!.description.length).toBeGreaterThan(0);
    expect(fm!["user-invocable"]).toBe("true");
    expect(fm!["argument-hint"]?.length).toBeGreaterThan(0);
  });
});

describe("plugin skill lint — intake body", () => {
  test("quotes only tools that exist on the eleven-tool surface", () => {
    const quoted = quotedToolNames(body(INTAKE));
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.filter((name) => !TOOLS.has(name))).toEqual([]);
  });

  test("names the tools its flow depends on", () => {
    for (const tool of ["get_project", "search_documents", "create_document", "list_documents"]) {
      expect(INTAKE).toContain(tool);
    }
  });

  test("the amendment route uses the title convention and the (vN) suffix rule", () => {
    // The prefix is what the server's routing reads — em dash, one space either
    // side. A hyphen files a note with an odd name and nothing else.
    expect(INTAKE).toContain("Amendment — ");
    expect(INTAKE).toContain("(<version>)");
  });

  test("hands a spec-now idea to the plan skill rather than absorbing it", () => {
    expect(INTAKE).toContain("/kairoku:plan");
  });

  test("parks an idea as a note document", () => {
    expect(INTAKE).toMatch(/type:\s*"note"/);
  });

  test("forbids minting a stub plan item (invariant 3)", () => {
    expect(INTAKE).toMatch(/never[\s\S]{0,60}upsert_plan/i);
  });

  test("forbids any Jira write or 'filed a ticket' claim (invariant 1)", () => {
    expect(INTAKE).toMatch(/never[\s\S]{0,80}Jira/i);
  });

  test("forbids filing into Unsorted/", () => {
    expect(INTAKE).toMatch(/never[\s\S]{0,40}`?Unsorted\//i);
  });

  test("release creation is proposed in words, never called", () => {
    // There is no create_release on the surface and there must not be one here:
    // a twelfth tool is a plan amendment, not an edit. Asserted as a literal
    // absence because the tool cross-check above can only police names that
    // exist — an invented one would fail it, but this says why.
    expect(INTAKE).not.toContain("create_release");
  });
});
