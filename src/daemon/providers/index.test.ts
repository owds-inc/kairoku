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

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionProviders } from "./index";
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
