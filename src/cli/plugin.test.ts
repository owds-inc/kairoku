import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
