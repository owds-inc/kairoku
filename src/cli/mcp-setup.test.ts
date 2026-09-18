/**
 * `kairoku mcp setup` — wiring `mcp-bridge` into codex/claude as a stdio MCP
 * server. Asserts the exact argv each add command gets, that a prior stale
 * entry is removed first (codex), and that it refuses without a prior login.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./mcp-setup";
import { fakeIo, type FakeIo } from "./testkit";

const LOGGED_IN = {
  "/home/tester/.kairoku/config.json": JSON.stringify({
    mcp: { appUrl: "https://dev.kairoku.io", ownerId: "org_x", resource: "https://dev.kairoku.io/api/mcp" },
  }),
};

function testIo(overrides: Partial<FakeIo> = {}): FakeIo {
  return fakeIo({ home: "/home/tester", execPath: "/usr/local/bin/kairoku", files: LOGGED_IN, ...overrides });
}

describe("kairoku mcp setup", () => {
  test("refuses without a prior login", async () => {
    const io = testIo({ files: {}, bins: new Set(["codex", "claude"]) });
    const code = await run([], io);
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("not logged in");
    expect(io.calls).toEqual([]);
  });

  test("codex: exact argv — remove then add with --command/--args, no URL, no bearer", async () => {
    const io = testIo({ bins: new Set(["codex"]) });
    const code = await run(["--agent", "codex"], io);
    expect(code).toBe(0);
    expect(io.calls).toEqual([
      ["codex", "mcp", "remove", "kairoku"],
      ["codex", "mcp", "add", "kairoku", "--command", "/usr/local/bin/kairoku", "--args", "mcp-bridge"],
    ]);
  });

  test("claude: exact argv — user scope, stdio transport, command after --", async () => {
    const io = testIo({ bins: new Set(["claude"]) });
    const code = await run(["--agent", "claude"], io);
    expect(code).toBe(0);
    expect(io.calls).toEqual([
      ["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", "kairoku", "--", "/usr/local/bin/kairoku", "mcp-bridge"],
    ]);
  });

  test("--agent all runs both when both are present, and prints the pi line", async () => {
    const io = testIo({ bins: new Set(["codex", "claude"]) });
    const code = await run([], io);
    expect(code).toBe(0);
    expect(io.calls).toEqual([
      ["codex", "mcp", "remove", "kairoku"],
      ["codex", "mcp", "add", "kairoku", "--command", "/usr/local/bin/kairoku", "--args", "mcp-bridge"],
      ["claude", "mcp", "add", "--scope", "user", "--transport", "stdio", "kairoku", "--", "/usr/local/bin/kairoku", "mcp-bridge"],
    ]);
    expect(io.lines.join("\n")).toContain("pi: not configured");
  });

  test("an agent not present on PATH is skipped, not failed", async () => {
    const io = testIo({ bins: new Set() });
    const code = await run(["--agent", "codex"], io);
    expect(code).toBe(0);
    expect(io.calls).toEqual([]);
    expect(io.lines.join("\n")).toContain("not found on PATH");
  });
});
