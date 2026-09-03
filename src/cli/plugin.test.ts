import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./plugin";
import { fakeIo } from "./testkit";

const root = join(import.meta.dir, "..", "..");
const read = (rel: string) =>
  JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, any>;

describe("plugin manifests", () => {
  test("marketplace.json points at plugin/ and the names agree", () => {
    const market = read(".claude-plugin/marketplace.json");
    const plugin = read("plugin/.claude-plugin/plugin.json");
    expect(market.name).toBe("kairoku-marketplace");
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0].source).toBe("./plugin/");
    expect(market.plugins[0].name).toBe(plugin.name);
    expect(plugin.name).toBe("kairoku");
  });

  test("plugin.json points at this repo", () => {
    const plugin = read("plugin/.claude-plugin/plugin.json");
    expect(plugin.homepage).toBe("https://github.com/owds-inc/kairoku");
    expect(plugin.repository).toBe("https://github.com/owds-inc/kairoku");
    expect(plugin.license).toBe("MIT");
  });
});

// -------------------------------------------------------- plugin/codex-manifest
//
// Codex has no `${user_config...}` interpolation (Claude Code's own plugin
// syntax) and keeps the placeholder as literal text, so the Codex manifest
// names the MCP server with an absolute URL instead of pointing at the same
// `.mcp.json` Claude reads.
describe("the Codex manifest", () => {
  test("parses and names the kairoku MCP server with a literal, bearer-free URL", () => {
    const codex = read("plugin/.codex-plugin/plugin.json");
    expect(codex.name).toBe("kairoku");
    expect(codex.mcpServers.kairoku.type).toBe("http");
    expect(codex.mcpServers.kairoku.url).toBe("https://kairoku.io/api/mcp");
    expect(codex.mcpServers.kairoku.url).not.toContain("${");
    expect(codex.mcpServers.kairoku).not.toHaveProperty("bearer_token_env_var");
  });

  test("Claude Code's .mcp.json still carries the ${user_config...} interpolation Codex cannot read", () => {
    const mcp = read("plugin/.mcp.json");
    expect(mcp.mcpServers.kairoku.url).toBe("${user_config.kairoku_url}/api/mcp");
  });

  test("both manifests agree on the plugin's own version", () => {
    const claude = read("plugin/.claude-plugin/plugin.json");
    const codex = read("plugin/.codex-plugin/plugin.json");
    expect(codex.version).toBe(claude.version);
    expect(claude.version).toBe("2.4.1");
  });
});

const noMarketplaces = JSON.stringify([{ name: "claude-plugins-official", source: "github" }]);
const withMarketplace = JSON.stringify([
  { name: "kairoku-marketplace", source: "github", repo: "owds-inc/kairoku" },
]);
const notInstalled = JSON.stringify([{ id: "other@claude-plugins-official", version: "1.0.0", enabled: true }]);
const installed = JSON.stringify([
  { id: "kairoku@kairoku-marketplace", version: "2.2.0", scope: "user", enabled: true },
]);

function withClaude(canned: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const io = fakeIo({ canned });
  io.bins.add("claude");
  return io;
}

describe("kairoku plugin", () => {
  test("install adds the marketplace then installs the plugin, both non-interactive", async () => {
    const io = withClaude({
      "claude plugin marketplace list --json": { stdout: noMarketplaces },
      "claude plugin list --json": { stdout: notInstalled },
    });
    expect(await run(["install"], io)).toBe(0);
    expect(io.calls).toEqual([
      ["claude", "plugin", "marketplace", "list", "--json"],
      ["claude", "plugin", "marketplace", "add", "owds-inc/kairoku"],
      ["claude", "plugin", "list", "--json"],
      ["claude", "plugin", "install", "kairoku@kairoku-marketplace", "--scope", "user"],
    ]);
  });

  test("install is idempotent: an existing registration and install are left alone", async () => {
    const io = withClaude({
      "claude plugin marketplace list --json": { stdout: withMarketplace },
      "claude plugin list --json": { stdout: installed },
    });
    expect(await run(["install"], io)).toBe(0);
    expect(io.calls.map((c) => c.join(" "))).toEqual([
      "claude plugin marketplace list --json",
      "claude plugin list --json",
    ]);
    expect(io.lines.join("\n")).toContain("already installed");
    expect(io.lines.join("\n")).toContain("2.2.0");
  });

  test("install returns the claude CLI's failure", async () => {
    const io = withClaude({
      "claude plugin marketplace list --json": { stdout: withMarketplace },
      "claude plugin list --json": { stdout: notInstalled },
      "claude plugin install": { code: 1 },
    });
    expect(await run(["install"], io)).toBe(1);
  });

  test("update refreshes the marketplace then updates the plugin with -y", async () => {
    const io = withClaude({});
    expect(await run(["update"], io)).toBe(0);
    expect(io.calls).toEqual([
      ["claude", "plugin", "marketplace", "update", "kairoku-marketplace"],
      ["claude", "plugin", "update", "kairoku@kairoku-marketplace", "-y"],
    ]);
  });

  test("status reports the installed version and enabled state", async () => {
    const io = withClaude({ "claude plugin list --json": { stdout: installed } });
    expect(await run(["status"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("kairoku@kairoku-marketplace 2.2.0");
    expect(io.lines.join("\n")).toContain("enabled");
  });

  test("status exits 1 when the plugin is not installed", async () => {
    const io = withClaude({ "claude plugin list --json": { stdout: notInstalled } });
    expect(await run(["status"], io)).toBe(1);
    expect(io.lines.join("\n")).toContain("kairoku plugin install");
  });

  test("without claude on PATH every verb says how to install it and exits 1", async () => {
    for (const verb of ["install", "update", "status"]) {
      const io = fakeIo();
      expect(await run([verb], io)).toBe(1);
      expect(io.calls).toEqual([]);
      expect(io.errors.join("\n")).toContain("npm install -g @anthropic-ai/claude-code");
    }
  });

  test("a missing or unknown verb prints usage and exits 2", async () => {
    for (const args of [[], ["frobnicate"]]) {
      const io = withClaude({});
      expect(await run(args, io)).toBe(2);
      expect(io.errors.join("\n")).toContain("kairoku plugin install|update|status");
    }
  });
});
