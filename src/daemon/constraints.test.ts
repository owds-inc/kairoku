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
 *
 * THE ZERO-DEPENDENCY RULE IS AMENDED, NOT DROPPED (§20.2). The Claude Agent
 * SDK is the daemon's one runtime dependency and `providers/claude.ts` is the
 * one module allowed to import it. Two things follow, and both are pinned
 * below: the dependency list is exactly that one entry, and the scan now
 * RECURSES — a rule that only reads the top directory would treat
 * `providers/`, `roles/` and anything else added later as a place the rules do
 * not apply, which is the opposite of what a structural test is for.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DAEMON_ROUTES } from "./app";

const srcDir = import.meta.dir;
const repoDir = join(srcDir, "..", "..");

/** The one module allowed to dial out. */
const OUTBOUND_MODULE = "app.ts";

/** §20.2 — the daemon's one runtime dependency, and the one file that may import it. */
export const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";
const SDK_MODULE = join("providers", "claude.ts");

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

/** Every production `.ts` under `src/daemon/`, at any depth, named relative to it. */
function productionSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts") &&
        entry.name !== "testkit.ts"
      ) {
        out.push([relative(srcDir, path), stripComments(readFileSync(path, "utf8"))]);
      }
    }
  };
  walk(srcDir);
  return out;
}

describe("SPEC constraints", () => {
  test("the scan reaches every subdirectory, so no folder is a place the rules do not apply", () => {
    const names = productionSources().map(([name]) => name);
    expect(names).toContain("app.ts");
    expect(names).toContain(SDK_MODULE);
    expect(names.some((name) => name.includes(sep))).toBe(true);
  });

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

  test("no module but app.ts, link.ts and config.ts even knows the app exists", () => {
    // Keeping the surface this small is what makes a protocol change a change
    // to two files rather than a sweep.
    const knows = /appUrl|api\/daemon|heartbeat|Bearer /;
    for (const [name, source] of productionSources()) {
      const allowed = ["app.ts", "link.ts", "config.ts"].includes(name);
      expect({ [name]: knows.test(source) && !allowed }).toEqual({ [name]: false });
    }
  });

  test("§20.2: the daemon has exactly ONE runtime dependency, and it is the Agent SDK", () => {
    const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys((pkg.dependencies ?? {}) as Record<string, string>)).toEqual([AGENT_SDK]);
    // Pinned exactly: `effort`, `outputFormat` and `dontAsk` are recent, and a
    // range would let a machine resolve a version without them.
    expect(((pkg.dependencies as Record<string, string>)[AGENT_SDK] ?? "")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys((pkg.devDependencies ?? {}) as Record<string, string>).sort()).toEqual([
      "@types/bun",
      "typescript",
    ]);
  });

  test("§20.2: only providers/claude.ts imports the SDK", () => {
    for (const [name, source] of productionSources()) {
      const imports = source.includes(AGENT_SDK);
      expect({ [name]: imports && name !== SDK_MODULE }).toEqual({ [name]: false });
    }
    expect(productionSources().find(([name]) => name === SDK_MODULE)?.[1]).toContain(AGENT_SDK);
  });

  test("only node:, bun:, the SDK and relative imports appear in production modules", () => {
    const importRe = /from\s+["']([^"']+)["']/g;
    for (const [name, source] of productionSources()) {
      for (const match of source.matchAll(importRe)) {
        const specifier = match[1]!;
        const allowed =
          specifier.startsWith("node:") ||
          specifier.startsWith("bun:") ||
          specifier.startsWith(".") ||
          (specifier === AGENT_SDK && name === SDK_MODULE);
        expect({ [`${name} imports ${specifier}`]: allowed }).toEqual({
          [`${name} imports ${specifier}`]: true,
        });
      }
    }
  });

  test("§20.8: the policy is decided in one module, and the providers both read it", () => {
    // A second copy of "what a reviewer may do" is how the two providers drift
    // into meaning different things by the same word.
    const sources = new Map(productionSources());
    for (const provider of [SDK_MODULE, join("providers", "codex.ts")]) {
      expect({ [provider]: /from "\.\.\/policy"/.test(sources.get(provider) ?? "") }).toEqual({ [provider]: true });
    }
  });
});
