/**
 * Structural invariants the SPEC states about the daemon as a whole. They are
 * asserted mechanically because a reviewer cannot re-read every module on every
 * change, and both of these are the kind of thing that erodes one import at a
 * time.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcDir = import.meta.dir;
const repoDir = join(srcDir, "..");

/**
 * Strip block comments and whole-line comments so that prose ABOUT a rule is
 * not mistaken for a breach of it — every module here names Jira and Kairoku
 * in its header. A code line keeps its trailing text, so a URL inside a string
 * (`"http://jira…"`) is still scanned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function productionSources(): Array<[string, string]> {
  return readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testkit.ts")
    .map((f) => [f, stripComments(readFileSync(join(srcDir, f), "utf8"))]);
}

describe("SPEC constraints", () => {
  test("RF-007: the runner never talks to Kairoku, Jira or GitHub", () => {
    // It holds no credential for any of them by construction; only the agents
    // it launches report anything. An outbound call from here would be the
    // daemon making a claim about work it did not do.
    const forbidden =
      /atlassian|jira|\.githubusercontent|api\.github|githubapi|KAIROKU_URL|kairoku\.(app|dev|com)|mcp__/i;
    for (const [name, source] of productionSources()) {
      expect({ [name]: forbidden.test(source) }).toEqual({ [name]: false });
    }
  });

  test("RF-007: no production module opens an outbound HTTP client", () => {
    // Bun.serve (inbound) is expected; fetch/WebSocket/http.request are not.
    const outbound = /\b(fetch\s*\(|new WebSocket|https?\.request|axios)/;
    for (const [name, source] of productionSources()) {
      expect({ [name]: outbound.test(source) }).toEqual({ [name]: false });
    }
  });

  test("the daemon has zero runtime dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
      "@types/bun",
      "typescript",
    ]);
  });

  test("only node:, bun: and relative imports appear in production modules", () => {
    const importRe = /from\s+["']([^"']+)["']/g;
    for (const [name, source] of productionSources()) {
      for (const match of source.matchAll(importRe)) {
        const specifier = match[1]!;
        const allowed =
          specifier.startsWith("node:") ||
          specifier.startsWith("bun:") ||
          specifier.startsWith(".");
        expect({ [`${name} imports ${specifier}`]: allowed }).toEqual({
          [`${name} imports ${specifier}`]: true,
        });
      }
    }
  });
});
