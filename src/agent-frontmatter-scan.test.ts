import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * The plugin's agent definitions, checked for the things nothing else checks.
 *
 * WHY THIS EXISTS
 * ---------------
 * `claude plugin validate --strict` passes on this plugin and reads ONLY
 * `plugin/.claude-plugin/plugin.json` — its own output says so
 * ("Validating plugin manifest: …/plugin.json"). It never opens an agent
 * definition. Nothing in the manifest even references the agents directory, so
 * there is no path by which it could. For as long as anyone has said "the
 * plugin validates", agent frontmatter has been entirely unchecked.
 *
 * That gap has already cost real work. `maxTurns` sat at 120, which is below
 * what an ordinary story needs: three agents hit it in a single session at 167,
 * 179 and 146 tool calls. Each stopped MID-SENTENCE with 200+ lines of correct
 * but uncommitted code, and each returned a closing message indistinguishable
 * from a normal finish. The failure was invisible from the report — the only
 * way to tell a truncated run from a completed one was to open the worktree.
 *
 * A wrong value here does not throw. It quietly changes what the agent can do
 * and then reads as success, which is exactly the shape this repo keeps
 * building scans for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not claim to validate against the CLI's real agent schema — there is
 * no published schema to validate against, and inventing one here would be a
 * fiction that fails on the next legitimate key. It pins the keys this repo
 * actually relies on, and the VALUES whose being wrong is silent.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const AGENTS_DIR = path.join(ROOT, "plugin/agents");
const SKILLS_DIR = path.join(ROOT, "plugin/skills");
const MANIFEST = path.join(ROOT, "plugin/.claude-plugin/plugin.json");

type Frontmatter = {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  raw: string;
};

/**
 * Enough YAML for this shape and no more: `key: value`, `key: >-` with a folded
 * block, and `key:` followed by `  - item`. Comment lines are skipped, which is
 * load-bearing — two of the values here carry a comment above them explaining
 * why they are what they are, and a parser that choked on those would push
 * people to delete the explanations.
 */
function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const raw = text.slice(4, end);

  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // continuation, consumed below

    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;

    if (rest === "" || rest === ">-" || rest === "|" || rest === ">") {
      const folded: string[] = [];
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === "") continue;
        if (!/^\s/.test(next)) break;
        const inner = next.trim();
        if (inner.startsWith("#")) continue;
        if (inner.startsWith("- ")) items.push(inner.slice(2).trim());
        else folded.push(inner);
      }
      if (items.length) lists[key] = items;
      if (folded.length) scalars[key] = folded.join(" ");
    } else {
      scalars[key] = rest.trim();
    }
  }
  return { scalars, lists, raw };
}

const agentFiles = existsSync(AGENTS_DIR)
  ? readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))
  : [];

/**
 * The floor, and the reason it is not 120.
 *
 * Measured, not guessed: 167, 179 and 146 tool calls on three ordinary stories
 * in one session, all of which were essentially complete when cut off. A cap
 * has to sit above what real work costs or it is a silent truncator, and the
 * cost of setting it too high is only a slower runaway — which is loud —
 * against a cap set too low, which is silent.
 */
const MIN_MAX_TURNS = 300;

const ALLOWED = {
  model: ["fable", "opus", "sonnet", "haiku", "inherit"],
  effort: ["low", "medium", "high", "xhigh", "max"],
  isolation: ["worktree", "remote"],
} as const;

describe("plugin agent frontmatter", () => {
  // A scan over nothing passes for the wrong reason.
  test("at least one agent definition is found and non-empty", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const file of agentFiles) {
      expect(readFileSync(path.join(AGENTS_DIR, file), "utf8").length).toBeGreaterThan(0);
    }
  });

  test("every agent has parseable frontmatter with name and description", () => {
    for (const file of agentFiles) {
      const fm = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"));
      expect(fm).not.toBeNull();
      expect(fm!.scalars.name).toBeTruthy();
      expect(fm!.scalars.description).toBeTruthy();
      // The name is the address the Agent tool resolves; a mismatch with the
      // filename resolves to nothing and reads as "agent not found".
      expect(fm!.scalars.name).toBe(file.replace(/\.md$/, ""));
    }
  });

  test("every skill an agent names resolves to a real skill on disk", () => {
    for (const file of agentFiles) {
      const fm = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"))!;
      const skills = fm.lists.skills ?? [];
      expect(skills.length).toBeGreaterThan(0);
      for (const entry of skills) {
        // `kairoku:jira-ops` → plugin/skills/jira-ops/SKILL.md
        const name = entry.includes(":") ? entry.slice(entry.lastIndexOf(":") + 1) : entry;
        const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
        expect({ entry, exists: existsSync(skillFile) }).toEqual({ entry, exists: true });
      }
    }
  });

  test("scalar keys carry values the runtime actually accepts", () => {
    for (const file of agentFiles) {
      const fm = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"))!;
      for (const [key, allowed] of Object.entries(ALLOWED)) {
        const value = fm.scalars[key];
        if (value === undefined) continue; // optional; absence is inherit
        expect({ key, value, ok: (allowed as readonly string[]).includes(value) }).toEqual({
          key,
          value,
          ok: true,
        });
      }
    }
  });

  // THE ONE THIS FILE EXISTS FOR.
  test("maxTurns is a number and sits above what real stories actually cost", () => {
    for (const file of agentFiles) {
      const fm = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"))!;
      const raw = fm.scalars.maxTurns;
      if (raw === undefined) continue;
      expect(raw).toMatch(/^\d+$/);
      const value = Number(raw);
      expect({ file, value, atLeast: MIN_MAX_TURNS, ok: value >= MIN_MAX_TURNS }).toEqual({
        file,
        value,
        atLeast: MIN_MAX_TURNS,
        ok: true,
      });
    }
  });

  /**
   * NEGATIVE CONTROL. A `tools:` list looks like tightening security and is
   * the opposite: it silently drops the MCP tools (Atlassian, Kairoku) and
   * ToolSearch, leaving the agent unable to reach Jira or Confluence at all.
   * Proven on a real acceptance run. The reason must stay beside the absence,
   * or the next person adds the list back as an obvious improvement.
   */
  test("no agent declares a tools list, and the reason is recorded beside it", () => {
    for (const file of agentFiles) {
      const text = readFileSync(path.join(AGENTS_DIR, file), "utf8");
      const fm = parseFrontmatter(text)!;
      expect(fm.scalars.tools).toBeUndefined();
      expect(fm.lists.tools).toBeUndefined();
      // Asserted on the mechanism, not on wording — this sentence will be
      // rewritten and a wording pin would fail on an improvement.
      expect(fm.raw).toMatch(/tools/i);
      expect(fm.raw).toMatch(/MCP/);
    }
  });

  /**
   * The finding this whole file is downstream of, pinned so it cannot be
   * forgotten and quietly re-assumed.
   *
   * `claude plugin validate --strict` reports "Validating plugin manifest:
   * …/plugin.json" and stops there. The manifest contains no reference to the
   * agents directory, so there is no route by which validation could reach an
   * agent definition. This asserts that structural fact rather than the CLI's
   * behaviour: if the manifest ever DOES start pointing at agents, this test
   * fails and someone re-checks whether validation now covers them — at which
   * point some of this file may be redundant, which is a good problem.
   */
  test("the manifest does not reference the agents directory — which is WHY validate cannot see it", () => {
    const manifest = readFileSync(MANIFEST, "utf8");
    expect(manifest.length).toBeGreaterThan(0);
    const parsed = JSON.parse(manifest) as Record<string, unknown>; // it must at least be valid JSON

    // The canonical manifest in this repo (plugin v2.4.1) says "the four orchestration role
    // agents the daemon drives" in its `description` — marketplace prose for a human reading
    // the listing, and not a path anything follows. A bare substring check on the file text
    // failed on that sentence, which would have made the guard argue with an accurate
    // description instead of with a real reference.
    //
    // So the structural fact is asserted structurally: no top-level KEY names the directory,
    // and no value OUTSIDE `description` mentions it. Improving the description cannot fail
    // this; a manifest that actually starts pointing at `agents/` cannot pass it, and that is
    // the day someone re-checks whether `validate` now reaches an agent definition.
    expect(Object.keys(parsed)).not.toContain("agents");
    const { description: _description, ...rest } = parsed;
    expect(JSON.stringify(rest)).not.toContain("agents");
    expect(manifest).not.toContain("implementer.md");
  });
});
