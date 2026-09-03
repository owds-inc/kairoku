import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSummary, qaPlan, runQa, tail } from "./qa";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-qa-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("qa — the summary parsers (one per known runner)", () => {
  test("bun's four counters, errors line and all", () => {
    expect(
      parseSummary(["", " 341 pass", " 2 skip", " 1 fail", " 3 errors", "Ran 344 tests across 12 files."].join("\n")),
    ).toEqual({ pass: 341, fail: 1, skip: 2, errors: 3 });
  });

  test("bun prints no errors line when there are none, and absent means zero there", () => {
    expect(parseSummary(" 10 pass\n 0 fail\nRan 10 tests across 2 files.")).toEqual({
      pass: 10,
      fail: 0,
      skip: 0,
      errors: 0,
    });
  });

  test("vitest", () => {
    expect(parseSummary("Test Files  1 failed | 4 passed (5)\n     Tests  3 failed | 10 passed | 2 skipped (15)")).toEqual(
      { pass: 10, fail: 3, skip: 2, errors: 0 },
    );
  });

  test("jest", () => {
    expect(parseSummary("Tests:       1 failed, 2 skipped, 10 passed, 13 total")).toEqual({
      pass: 10,
      fail: 1,
      skip: 2,
      errors: 0,
    });
  });

  test("go test -v", () => {
    expect(
      parseSummary(["--- PASS: TestA (0.00s)", "--- FAIL: TestB (0.01s)", "--- SKIP: TestC (0.00s)", "FAIL"].join("\n")),
    ).toEqual({ pass: 1, fail: 1, skip: 1, errors: 0 });
  });

  test("an unknown runner yields nothing — which the step treats as a failure", () => {
    expect(parseSummary("everything went great, honestly")).toBeUndefined();
    expect(parseSummary("")).toBeUndefined();
  });
});

describe("qa — what gets run", () => {
  test("the manifest's check[] then test, when there is a manifest", () => {
    const wt = worktree({
      "kairoku.json": JSON.stringify({ check: ["make lint", "make types"], test: "make test", concurrency: { test: 3 } }),
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }),
    });
    expect(qaPlan(wt)).toEqual({
      check: ["make lint", "make types"],
      test: "make test",
      concurrency: 3,
      source: "kairoku.json",
    });
  });

  test("package.json's lint, build and its OWN test script are what get run", () => {
    // `test` is the package's script, run through the package manager — never
    // `bun test` in its place. Against a repo whose `test` is `vitest run`,
    // bun's runner walks the same files and usually prints "0 pass · 0 fail",
    // which `parseSummary` reads as a clean zero-count suite; the member would
    // then report done citing counts no suite of this repo ever produced.
    const wt = worktree({
      "package.json": JSON.stringify({ scripts: { lint: "eslint .", build: "bun run b", test: "vitest run", start: "x" } }),
      "bun.lock": "{}",
    });
    expect(qaPlan(wt)).toEqual({
      check: ["bun run lint", "bun run build"],
      test: "bun run test",
      concurrency: 1,
      source: "package.json",
    });
  });

  test("the lockfile names the package manager the scripts are run through", () => {
    const scripts = { scripts: { build: "tsc", test: "jest" } };
    const pnpm = worktree({ "package.json": JSON.stringify(scripts), "pnpm-lock.yaml": "lockfileVersion: 9" });
    expect(qaPlan(pnpm)).toMatchObject({ check: ["pnpm run build"], test: "pnpm run test" });

    // yarn has no `run` for a script: `yarn test` is the invocation.
    const yarn = worktree({ "package.json": JSON.stringify(scripts), "yarn.lock": "" });
    expect(qaPlan(yarn)).toMatchObject({ check: ["yarn build"], test: "yarn test" });

    // No lockfile this daemon knows: npm, the one every install leaves working.
    const npm = worktree({ "package.json": JSON.stringify(scripts) });
    expect(qaPlan(npm)).toMatchObject({ check: ["npm run build"], test: "npm run test" });
  });

  test("a package.json with no test script cites no suite — counts unavailable is a FAILURE", async () => {
    const wt = worktree({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) });
    const plan = qaPlan(wt);
    expect(plan.test).toBeUndefined();
    const result = await runQa(wt, { plan, exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no test command");
    expect(result.counts).toBeUndefined();
  });

  test("a repo with neither has nothing to run, and says so", () => {
    expect(qaPlan(worktree({}))).toEqual({ check: [], concurrency: 1, source: "none" });
  });
});

describe("qa — the step (§20 item 4, no model)", () => {
  const plan = { check: ["true"], test: "bun test", concurrency: 1, source: "package.json" as const };

  test("checks then test, four counts, clean", async () => {
    const ran: string[] = [];
    const result = await runQa("/wt", {
      plan,
      exec: async (command) => {
        ran.push(command);
        return { code: 0, stdout: " 10 pass\n 0 fail\nRan 10 tests across 2 files.", stderr: "" };
      },
    });
    expect(ran).toEqual(["true", "bun test"]);
    expect(result).toMatchObject({ ok: true, counts: { pass: 10, fail: 0, skip: 0, errors: 0 } });
  });

  test("a failing check stops before the test and attaches the last 100 lines", async () => {
    const ran: string[] = [];
    const noisy = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const result = await runQa("/wt", {
      plan,
      exec: async (command) => {
        ran.push(command);
        return { code: 2, stdout: noisy, stderr: "" };
      },
    });
    expect(ran).toEqual(["true"]);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("true");
    expect(result.defect!.split("\n")).toHaveLength(100);
    expect(result.defect).toContain("line 299");
    expect(result.defect).not.toContain("line 199");
  });

  test("fail > 0 fails the step and the tail is the defect", async () => {
    const result = await runQa("/wt", {
      plan: { ...plan, check: [] },
      exec: async () => ({ code: 1, stdout: " 8 pass\n 2 fail\n", stderr: "expected true to be false" }),
    });
    expect(result).toMatchObject({ ok: false, counts: { pass: 8, fail: 2, skip: 0, errors: 0 } });
    expect(result.defect).toContain("expected true to be false");
  });

  test("errors > 0 fails the step even with zero failures (invariant 7)", async () => {
    const result = await runQa("/wt", {
      plan: { ...plan, check: [] },
      exec: async () => ({ code: 0, stdout: " 8 pass\n 0 fail\n 1 error\n", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.counts).toEqual({ pass: 8, fail: 0, skip: 0, errors: 1 });
  });

  test("a runner nobody can parse is counts unavailable, and that is a failure", async () => {
    const result = await runQa("/wt", {
      plan,
      exec: async () => ({ code: 0, stdout: "all good!", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.counts).toBeUndefined();
    expect(result.summary).toContain("counts unavailable");
  });

  test("a repo with no test command cannot cite a suite, so the step fails closed", async () => {
    const result = await runQa("/wt", {
      plan: { check: [], concurrency: 1, source: "none" },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no test command");
  });

  test("concurrency.test bounds how many suites run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(20);
      inFlight--;
      return { code: 0, stdout: " 1 pass\n 0 fail\n", stderr: "" };
    };
    const two = { check: [], test: "bun test", concurrency: 2, source: "kairoku.json" as const };
    await Promise.all([1, 2, 3, 4].map(() => runQa("/wt", { plan: two, exec: slow })));
    expect(peak).toBe(2);
  });
});

describe("qa — tail", () => {
  test("keeps the last n lines and never more", () => {
    expect(tail("a\nb\nc", 2)).toBe("b\nc");
    expect(tail("a", 100)).toBe("a");
    expect(tail("", 100)).toBe("");
  });
});
