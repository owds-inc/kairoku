import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const main = join(import.meta.dir, "main.ts");

async function cli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", main, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("kairoku cli", () => {
  test("version prints the package version", async () => {
    const { code, stdout } = await cli("version");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("kairoku 0.1.0");
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const { code, stderr } = await cli("frobnicate");
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("kairoku version");
  });
});
