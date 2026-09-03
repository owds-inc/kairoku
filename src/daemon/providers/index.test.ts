/**
 * The PRODUCTION registry — the one constructor every production call site uses.
 *
 * These two tests exist because the bare `providerRegistry()` looked correct in
 * every unit test and delivered nothing in production: `claude.test.ts` hands
 * `claudeQueryOptions` a `pluginPath` directly and `e2e.test.ts` injects fake
 * providers, so neither ever asked what the REAL registry gives the SDK. The
 * answer was `plugins: undefined` — every real run started with no kairoku MCP
 * server, no protocol skills and no role agents.
 *
 * So the assertion is made where it could not drift: through
 * `productionProviders()`, with the SDK itself mocked, reading the options the
 * SDK was actually handed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginPathFor } from "../../cli/doctor";
import { pickPlugin } from "../../cli/plugin";
import { fakeIo } from "../../cli/testkit";
import { productionProviders, resolvePluginPath } from "./index";
import type { RoleRun } from "./types";

const run = (over: Partial<RoleRun> = {}): RoleRun => ({
  dispatchId: "d1",
  runId: "r1",
  role: "implementer",
  prompt: "build the thing",
  cwd: "/tmp/wt/r1",
  env: {},
  timeoutMs: 60_000,
  logPath: "/tmp/wt/r1.log",
  ...over,
});

/** Everything the SDK was handed, captured from inside a mocked `query()`. */
const seen: Array<Record<string, unknown>> = [];
let dir: string;
let claudeBin: string;
let pluginDir: string;
let realPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kairoku-prod-providers-"));
  claudeBin = join(dir, "claude");
  writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n");
  chmodSync(claudeBin, 0o755);
  pluginDir = join(dir, "plugin");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kairoku" }));
  realPath = process.env.PATH;
  process.env.PATH = dir;

  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: (params: { prompt: unknown; options?: Record<string, unknown> }) => {
      seen.push(params.options ?? {});
      return Object.assign(
        (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" };
        })(),
        { interrupt: async () => {}, supportedModels: async () => [] },
      );
    },
  }));
});

afterAll(() => {
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("productionProviders — what the SDK is actually handed", () => {
  test("the plugin and the resolved claude reach the SDK's options, not just the seam", async () => {
    seen.length = 0;
    const launched = productionProviders({ pluginPath: pluginDir }).claude.launch(run());
    for await (const _ of launched.events) void _;
    await launched.exit;

    expect(seen).toHaveLength(1);
    const options = seen[0]!;
    expect(options.plugins).toEqual([{ type: "local", path: pluginDir }]);
    expect(options.pathToClaudeCodeExecutable).toBe(claudeBin);
  });

  test("no plugin anywhere means the run FAILS CLOSED, naming what is missing", async () => {
    seen.length = 0;
    // Nothing resolves: no checkout beside the binary, nothing installed.
    const providers = productionProviders({}, () => undefined);
    const launched = providers.claude.launch(run());
    const events = [];
    for await (const event of launched.events) events.push(event);
    const exit = await launched.exit;

    expect(seen).toHaveLength(0);
    expect(exit.ok).toBe(false);
    expect(exit.summary).toContain("plugin");
    expect(events.at(-1)).toEqual({ kind: "error", text: expect.stringContaining("plugin") });
    expect(await providers.claude.models()).toEqual([]);
  });
});

/**
 * WHERE A RELEASED BINARY FINDS THE PLUGIN.
 *
 * The refusal above is only correct if the lookup is. It was not: candidate 1
 * was computed from `import.meta.dir`, which in a `bun build --compile` binary
 * is `/$bunfs/root` and can never resolve, and candidates 2-4 named directories
 * `claude plugin install` does not create. A shipped daemon therefore refused
 * every Claude run on a machine whose own `kairoku doctor` said the plugin was
 * installed and enabled. These tests pin the layout Claude Code actually uses.
 */
describe("resolvePluginPath — where a RELEASED binary finds the plugin", () => {
  let home: string;
  const cacheDir = (h: string) => join(h, ".claude", "plugins", "cache", "kairoku-marketplace", "kairoku");
  const plant = (dir: string) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kairoku" }));
    return dir;
  };
  /** What `import.meta.dir` is inside a compiled binary. */
  const bunfs = "/$bunfs/root";
  const none = () => undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kairoku-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("the cache layout `claude plugin install` really writes, highest version by semver", () => {
    // 2.10.0 > 2.2.0 by semver and < by string order, which is the bug a
    // lexicographic sort would ship the day the minor reaches double digits.
    plant(join(cacheDir(home), "2.2.0"));
    plant(join(cacheDir(home), "2.10.0"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "2.10.0"));
  });

  test("a version directory with no .claude-plugin/plugin.json is not a plugin", () => {
    mkdirSync(join(cacheDir(home), "2.11.0"), { recursive: true });
    plant(join(cacheDir(home), "2.2.0"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "2.2.0"));
  });

  test("the installPath `claude plugin list --json` reports wins over the cache scan", () => {
    plant(join(cacheDir(home), "2.2.0"));
    const elsewhere = plant(join(home, "elsewhere", "plugin"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: () => elsewhere })).toBe(elsewhere);
  });

  test("the list route reuses doctor's ONE parser: another plugin's installPath is not ours", () => {
    const foreign = JSON.stringify([{ id: "atlassian@claude-plugins-official", installPath: "/somewhere/else" }]);
    expect(pickPlugin(foreign)).toBeNull();
    expect(pickPlugin(JSON.stringify([{ id: "kairoku@kairoku-marketplace", installPath: "/p" }]))?.installPath).toBe("/p");
  });

  test("a compiled binary drops the repo-relative candidate; a checkout keeps it", () => {
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBeUndefined();
    expect(resolvePluginPath({ home, moduleDir: import.meta.dir, installed: none })).toBe(
      join(import.meta.dir, "..", "..", "..", "plugin"),
    );
  });

  test("config.pluginPath wins, but a stale one falls through to the live install", () => {
    // A plugin update moves the version directory; a pluginPath recorded by
    // `kairoku setup --daemon` must not outlive the directory it names.
    plant(join(cacheDir(home), "2.3.0"));
    const configured = plant(join(home, "opt", "plugin"));
    expect(resolvePluginPath({ configured, home, moduleDir: bunfs, installed: none })).toBe(configured);
    rmSync(configured, { recursive: true, force: true });
    expect(resolvePluginPath({ configured, home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "2.3.0"));
  });

  /**
   * THE COMPARATOR MUST BE TOTAL. `Bun.semver.order` does not return a number
   * for a non-semver string — it raises `Invalid SemVer`, and a throw inside
   * `Array.prototype.sort` propagates straight out of `resolvePluginPath`, past
   * `productionProviders`, into `doctor`, `setup --daemon` and the daemon's own
   * link start. Both triggers are ordinary: macOS Finder writes `.DS_Store`
   * into any directory a person opens, and Claude Code names the version
   * directory with a commit hash whenever a marketplace entry carries no
   * version (five such installPaths on one developer box). A stray entry is
   * skipped exactly like a directory with no `.claude-plugin/plugin.json`.
   */
  test("a stray non-semver entry beside the versions is SKIPPED, never a throw", () => {
    plant(join(cacheDir(home), "2.2.0"));
    plant(join(cacheDir(home), "2.10.0"));
    writeFileSync(join(cacheDir(home), ".DS_Store"), "");
    plant(join(cacheDir(home), "06403d54c6c0"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "2.10.0"));
  });

  test("a cache of NOTHING BUT non-semver entries resolves undefined, and still does not throw", () => {
    mkdirSync(cacheDir(home), { recursive: true });
    writeFileSync(join(cacheDir(home), ".DS_Store"), "");
    plant(join(cacheDir(home), "06403d54c6c0"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBeUndefined();
  });

  /**
   * LAZY, IN ORDER. `claude plugin list --json` is a ~210 ms synchronous spawn,
   * and `productionProviders()` runs once per dispatch — so it must not happen
   * at all when the configured path still validates.
   */
  test("a configured path that validates spawns no `claude plugin list`", () => {
    const configured = plant(join(home, "opt", "plugin"));
    let listed = 0;
    const path = resolvePluginPath({
      configured,
      home,
      moduleDir: bunfs,
      installed: () => {
        listed++;
        return undefined;
      },
    });
    expect(path).toBe(configured);
    expect(listed).toBe(0);
  });

  /**
   * A VALID SEMVER PLUS A FOURTH COMPONENT IS THE SHAPE THAT ESCAPED. The first
   * fix filtered with `Bun.semver.satisfies(v, "*")`, which is NOT the domain of
   * `Bun.semver.order`: "2.2.0.bak" satisfies "*" and then raises `Invalid
   * SemVer` inside the sort, exactly as `.DS_Store` did. `mv 2.2.0 2.2.0.bak`
   * before pinning a version is the ordinary way a person keeps the old copy.
   *
   * So the domain test IS the comparator: an entry is a version candidate only
   * if `Bun.semver.order(entry, entry)` does not throw. Pre-releases come back
   * in with it — `satisfies("1.0.0-beta", "*")` is false, `order` accepts it.
   */
  test("a stray `2.2.0.bak` beside the versions is SKIPPED, never a throw", () => {
    plant(join(cacheDir(home), "2.2.0"));
    plant(join(cacheDir(home), "2.10.0"));
    plant(join(cacheDir(home), "2.2.0.bak"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "2.10.0"));
  });

  test("every stray name the fuzz turned up is skipped, alone and beside a version", () => {
    // Each of these returns satisfies(v, "*") === true and raises from order().
    const strays = [
      "2.2.0.bak", "2.2.0.old", "2.2.0.orig", "2.2.0.save", "2.2.0.tmp", "2.2.0.zip",
      "2.2.0.partial", "2.2.0.download", "2.2.0.1", "2.2.0~", "1.2.3.4", "2.2.0.1.1",
      "2.2.0\n", "1.0.0.0", "0.0.0.0", "10.20.30.40", "2.2.0.bak.bak", "2.2.0.rej",
      "2.2.0.swp", "2.2.0.lock", "2.2.0_bak", ".DS_Store", "06403d54c6c0",
    ];
    for (const stray of strays) {
      const h = mkdtempSync(join(tmpdir(), "kairoku-stray-"));
      try {
        // Alone: no version to fall back on, so the answer is undefined, not a throw.
        plant(join(cacheDir(h), stray));
        expect(resolvePluginPath({ home: h, moduleDir: bunfs, installed: none })).toBeUndefined();
        // Beside a real version: the version wins.
        plant(join(cacheDir(h), "2.4.0"));
        expect(resolvePluginPath({ home: h, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(h), "2.4.0"));
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    }
  });

  test("a pre-release and a `v` prefix are ACCEPTED — `order` takes both, `satisfies` did not", () => {
    plant(join(cacheDir(home), "1.0.0-beta"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "1.0.0-beta"));
    plant(join(cacheDir(home), "v2.2.0"));
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(home), "v2.2.0"));
  });

  /**
   * The contract is "never throws", not "skips every odd-looking name".
   * `Bun.semver.order` parses the leading token, so "2.2.0 copy" (Finder's
   * duplicate), "2.2.0-bak" and "2.2.0+bak" are IN the comparator's domain and
   * are ordered rather than skipped — and each of those directories does hold a
   * real `.claude-plugin/plugin.json`, so resolving one is the right answer.
   */
  test("a name `order` DOES take is ordered, not skipped, and still never throws", () => {
    for (const name of ["2.2.0 copy", "2.2.0-bak", "2.2.0+bak"]) {
      const h = mkdtempSync(join(tmpdir(), "kairoku-taken-"));
      try {
        plant(join(cacheDir(h), name));
        plant(join(cacheDir(h), "2.2.0.bak"));
        expect(resolvePluginPath({ home: h, moduleDir: bunfs, installed: none })).toBe(join(cacheDir(h), name));
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    }
  });

  test("fuzz: 2000 arbitrary names beside 2.2.0 and 2.10.0 — never a throw, always 2.10.0", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_~+ !#$%&'()@[]^{}|\n";
    const dir = cacheDir(home);
    plant(join(dir, "2.2.0"));
    plant(join(dir, "2.10.0"));
    for (let i = 0; i < 2000; i++) {
      let name = "";
      for (let n = 1 + Math.floor(Math.random() * 12); n > 0; n--) {
        name += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      // Not a plugin directory, so even a name that IS a version cannot win.
      if (name !== "." && name !== "..") writeFileSync(join(dir, name), "");
    }
    expect(resolvePluginPath({ home, moduleDir: bunfs, installed: none })).toBe(join(dir, "2.10.0"));
  });

  /** The two commands that crashed on a Finder-visited cache, through the resolver they share. */
  test("doctor and setup survive a `2.2.0.bak` in the cache", async () => {
    plant(join(cacheDir(home), "2.2.0"));
    plant(join(cacheDir(home), "2.2.0.bak"));
    const io = fakeIo({ home, exists: existsSync });
    io.bins.add("claude");
    io.canned["claude plugin list --json"] = { stdout: "[]" };
    expect(await pluginPathFor(io, undefined)).toBe(join(cacheDir(home), "2.2.0"));
  });

  /** The two commands that crashed on a Finder-visited cache, through the resolver they share. */
  test("doctor and setup survive a .DS_Store in the cache", async () => {
    plant(join(cacheDir(home), "2.2.0"));
    writeFileSync(join(cacheDir(home), ".DS_Store"), "");
    const io = fakeIo({ home, exists: existsSync });
    io.bins.add("claude");
    io.canned["claude plugin list --json"] = { stdout: "[]" };
    expect(await pluginPathFor(io, undefined)).toBe(join(cacheDir(home), "2.2.0"));
  });
});
