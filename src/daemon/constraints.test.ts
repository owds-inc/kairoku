/**
 * Structural invariants the SPEC states about the daemon as a whole. They are
 * asserted mechanically because a reviewer cannot re-read every module on every
 * change, and each of these is the kind of thing that erodes one import at a
 * time.
 *
 * RF-007 has FLIPPED with SPEC v1 (§20.3). The daemon used to talk to nothing;
 * it now talks to exactly one place for exactly three things, and that is the
 * property worth pinning: `app.ts` is the only module that may call `fetch`,
 * and the only URLs it may build are the three daemon routes under the
 * configured `appUrl`. A fourth route, a second outbound module, or a hardcoded
 * host all fail here rather than in production.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_ROUTES } from "./app";

const srcDir = import.meta.dir;
const repoDir = join(srcDir, "..", "..");

/** The one module allowed to dial out. */
const OUTBOUND_MODULE = "app.ts";

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
  test("RF-007 (amended): only app.ts opens an outbound client", () => {
    // Bun.serve (inbound) is expected; fetch/WebSocket/http.request are not —
    // anywhere but the one module whose whole job is the app link.
    const outbound = /\b(fetch\s*\(|new WebSocket|https?\.request|axios)/;
    for (const [name, source] of productionSources()) {
      const allowed = name === OUTBOUND_MODULE;
      expect({ [name]: outbound.test(source) && !allowed }).toEqual({ [name]: false });
    }
  });

  test("RF-011: app.ts calls the three daemon routes and nothing else", () => {
    const source = productionSources().find(([name]) => name === OUTBOUND_MODULE)?.[1] ?? "";
    const paths = [...source.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)].map((m) => m[1]!);
    expect([...new Set(paths)].sort()).toEqual([...DAEMON_ROUTES].sort());
    expect(paths.length).toBeGreaterThan(0);
  });

  test("RF-011: the app's address comes from config, never from a literal in the source", () => {
    // A hardcoded kairoku.io would send one operator's runs to another
    // operator's app the first time someone self-hosts.
    for (const [name, source] of productionSources()) {
      // A URL INTERPOLATED from config (`http://${config.listen.host}…`) is the
      // daemon's own listener and exactly what should be there; a fixed host is
      // the thing being refused.
      const literal = source.match(/["'`]https?:\/\/(?!\$\{)[^"'`]+["'`]/)?.[0];
      expect({ [name]: literal ?? null }).toEqual({ [name]: null });
    }
  });

  test("no module but app.ts and link.ts even knows the app exists", () => {
    // Keeping the surface this small is what makes protocol v1 (O-2/O-3) a
    // change to two files rather than a sweep.
    const knows = /appUrl|api\/daemon|heartbeat|Bearer /;
    for (const [name, source] of productionSources()) {
      const allowed = ["app.ts", "link.ts", "config.ts"].includes(name);
      expect({ [name]: knows.test(source) && !allowed }).toEqual({ [name]: false });
    }
  });

  test("the daemon has zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(["@types/bun", "typescript"]);
  });

  test("only node:, bun: and relative imports appear in production modules", () => {
    const importRe = /from\s+["']([^"']+)["']/g;
    for (const [name, source] of productionSources()) {
      for (const match of source.matchAll(importRe)) {
        const specifier = match[1]!;
        const allowed =
          specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier.startsWith(".");
        expect({ [`${name} imports ${specifier}`]: allowed }).toEqual({
          [`${name} imports ${specifier}`]: true,
        });
      }
    }
  });
});
