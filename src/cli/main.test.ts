import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "./main";
import { fakeIo } from "./testkit";

describe("kairoku cli", () => {
  test("version prints the package version", async () => {
    const io = fakeIo();
    expect(await main(["version"], io)).toBe(0);
    expect(io.lines).toEqual(["kairoku 0.1.0"]);
  });

  test("--version and -v are aliases", async () => {
    for (const flag of ["--version", "-v"]) {
      const io = fakeIo();
      expect(await main([flag], io)).toBe(0);
      expect(io.lines).toEqual(["kairoku 0.1.0"]);
    }
  });

  test("help, --help, -h and no arguments print usage on stdout", async () => {
    for (const args of [["help"], ["--help"], ["-h"], []]) {
      const io = fakeIo();
      expect(await main(args, io)).toBe(0);
      expect(io.lines.join("\n")).toContain("kairoku setup");
      expect(io.lines.join("\n")).toContain("kairoku doctor");
      // O-4 — the daemon's own value store is a command, not a file to edit.
      expect(io.lines.join("\n")).toContain("kairoku env");
    }
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const io = fakeIo();
    expect(await main(["frobnicate"], io)).toBe(2);
    expect(io.errors.join("\n")).toContain('unknown command "frobnicate"');
    expect(io.errors.join("\n")).toContain("kairoku version");
    expect(io.lines).toEqual([]);
  });

  test("--help / -h on any command prints that command's usage and does nothing else", async () => {
    const cases = [
      ["update", "kairoku update"],
      ["doctor", "kairoku doctor"],
      ["plugin", "kairoku plugin install|update|status"],
      ["daemon", "kairoku daemon [install|start|stop|status|prune]"],
      ["setup", "kairoku setup [--plugin]"],
      ["env", "kairoku env <set|import|list|rm>"],
    ] as const;
    for (const [command, marker] of cases) {
      for (const flag of ["--help", "-h"]) {
        const io = fakeIo();
        let fetched = 0;
        io.fetch = async () => {
          fetched++;
          return new Response("");
        };
        expect(await main([command, flag], io)).toBe(0);
        expect(io.lines.join("\n")).toContain(marker);
        expect(io.calls).toEqual([]);
        expect(fetched).toBe(0);
        expect(io.errors).toEqual([]);
      }
    }
  });

  test("the real entry runs: bun run main.ts version", async () => {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "main.ts"), "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("kairoku 0.1.0");
  });
});
