import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, type Manifest } from "./manifest";
import { parseSummary, qaPlan, runQa, tail, type QaPlan } from "./qa";

function manifestOf(source: unknown): Manifest {
  const parsed = parseManifest(JSON.stringify(source));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

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

describe("qa — the cargo nextest parser (R12; DECISIONS §79.6 item 4)", () => {
  // The three fixtures are summary lines this workspace recorded from real
  // kairokud runs: CONTINUITY.md:213 (!115), :257 (!109) and :4228. The record
  // strips nextest's own leading indentation, which is why test 4 asserts both.
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dir, "..", "..", "fixtures", "nextest", name), "utf8");
  const NEXTEST = "cargo nextest run --workspace --no-fail-fast";

  test("a clean run reads 1671 / 0 / 3 / 0", () => {
    expect(parseSummary(fixture("clean.txt"), NEXTEST)).toEqual({ pass: 1671, fail: 0, skip: 3, errors: 0 });
  });

  test("flaky and leaky move no count", () => {
    expect(parseSummary(fixture("flaky-leaky.txt"), NEXTEST)).toEqual({ pass: 5986, fail: 0, skip: 3, errors: 0 });
  });

  test("a failure, and nextest's singular `1 test run:`", () => {
    expect(parseSummary(fixture("failure.txt"), NEXTEST)).toEqual({ pass: 0, fail: 1, skip: 4213, errors: 0 });
  });

  test("the real indentation and the no-space bracket both parse", () => {
    // The fixture strips nextest's leading indentation; real output indents it.
    expect(parseSummary("     " + fixture("clean.txt"), NEXTEST)).toEqual({ pass: 1671, fail: 0, skip: 3, errors: 0 });
    expect(
      parseSummary("Summary [197.630s] 6063 tests run: 6063 passed (1 leaky), 2 skipped", NEXTEST),
    ).toEqual({ pass: 6063, fail: 0, skip: 2, errors: 0 });
  });

  test("only the LAST Summary line is read", () => {
    // The first line is synthetic — it stands in for a failing Rust test's
    // captured stdout, and is not a recorded form.
    expect(parseSummary("Summary [ 0.001s] 9 tests run: 9 passed, 0 skipped\n" + fixture("clean.txt"), NEXTEST)).toEqual({
      pass: 1671,
      fail: 0,
      skip: 3,
      errors: 0,
    });
  });

  test("without the command the parser is unreachable — selection is not sniffing", () => {
    expect(parseSummary(fixture("clean.txt"), NEXTEST)).toEqual({ pass: 1671, fail: 0, skip: 3, errors: 0 });
    expect(parseSummary(fixture("clean.txt"))).toBeUndefined();
    expect(parseSummary(fixture("clean.txt"), "bun test")).toBeUndefined();
  });

  test("a nextest command does not fall through to another parser", () => {
    expect(parseSummary(" 341 pass\n 2 skip\n 1 fail\n", NEXTEST)).toBeUndefined();
  });

  test("a nextest run that printed no Summary is counts-unavailable, not zero", () => {
    expect(parseSummary(fixture("clean.txt"), NEXTEST)).toEqual({ pass: 1671, fail: 0, skip: 3, errors: 0 });
    expect(parseSummary("Canceling due to test failure", NEXTEST)).toBeUndefined();
  });

  test("a +toolchain or an env prefix still selects nextest; a wrapper script does not", () => {
    expect(parseSummary(fixture("clean.txt"), "cargo +nightly nextest run")).toEqual({ pass: 1671, fail: 0, skip: 3, errors: 0 });
    expect(parseSummary(fixture("clean.txt"), "env RUST_LOG=warn cargo nextest run -p kairokud")).toEqual({
      pass: 1671,
      fail: 0,
      skip: 3,
      errors: 0,
    });
    expect(parseSummary(fixture("clean.txt"), "./scripts/nextest-wrapper.sh")).toBeUndefined();
  });

  test("runQa reads a nextest suite through the plan's own command", async () => {
    const plan = { check: [], test: NEXTEST, concurrency: 1, key: "owds-inc/kairoku", source: "kairoku.json" } satisfies QaPlan;
    const result = await runQa("/wt", {
      plan,
      exec: async () => ({ code: 0, stdout: fixture("clean.txt"), stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("QA: 1671 pass · 0 fail · 3 skip · 0 errors");
  });
});

describe("qa — what gets run", () => {
  test("the manifest's check[] then test, when there is a manifest", () => {
    const wt = worktree({ "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }) });
    const manifest = manifestOf({ check: ["make lint", "make types"], test: "make test", concurrency: { test: 3 } });
    expect(qaPlan(wt, { manifest, key: "owds-inc/kairoku" })).toEqual({
      check: ["make lint", "make types"],
      test: "make test",
      concurrency: 3,
      key: "owds-inc/kairoku",
      source: "kairoku.json",
    });
  });

  test("a kairoku.json sitting in the WORKTREE is ignored — the manifest comes from the base branch", () => {
    // The worktree is where the implementer is editing. A run whose check and
    // test commands could be rewritten by the agent under review is not a gate.
    const wt = worktree({
      "kairoku.json": JSON.stringify({ check: [], test: "echo ' 1 pass'" }),
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "bun.lock": "{}",
    });
    expect(qaPlan(wt)).toMatchObject({ test: "bun run test", source: "package.json" });
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
    expect(qaPlan(wt, { key: "owds-inc/other" })).toEqual({
      check: ["bun run lint", "bun run build"],
      test: "bun run test",
      concurrency: 1,
      key: "owds-inc/other",
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
    const wt = worktree({});
    expect(qaPlan(wt)).toEqual({ check: [], concurrency: 1, key: wt, source: "none" });
  });
});

describe("qa — the step (§20 item 4, no model)", () => {
  const plan = { check: ["true"], test: "bun test", concurrency: 1, key: "r", source: "package.json" as const };

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
    expect(result).toMatchObject({
      ok: true,
      counts: { pass: 10, fail: 0, skip: 0, errors: 0 },
      provenance: "package.json",
    });
  });

  test("runQa always returns plan.source as provenance (wire emitter)", async () => {
    for (const source of ["kairoku.json", "package.json", "none"] as const) {
      const result = await runQa("/wt", {
        plan: { check: [], test: source === "none" ? undefined : "bun test", concurrency: 1, key: "k", source },
        exec: async () => ({ code: 0, stdout: " 1 pass\n 0 fail\n", stderr: "" }),
      });
      expect(result.provenance).toBe(source);
    }
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
      plan: { check: [], concurrency: 1, key: "r", source: "none" },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no test command");
  });

  test("the check commands and the suite both run with the RUN'S environment", async () => {
    // Not the daemon's. A suite that inherited the machine's DATABASE_URL would
    // run green against the developer's own database while the run's compose
    // project sat there untouched.
    const seen: Array<Record<string, string> | undefined> = [];
    await runQa("/wt", {
      plan,
      env: { DATABASE_URL: "postgres://127.0.0.1:20001/main" },
      exec: async (_command, _cwd, env) => {
        seen.push(env);
        return { code: 0, stdout: " 1 pass\n 0 fail\n", stderr: "" };
      },
    });
    expect(seen).toHaveLength(2);
    for (const env of seen) expect(env?.DATABASE_URL).toBe("postgres://127.0.0.1:20001/main");
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
    const two = { check: [], test: "bun test", concurrency: 2, key: "one/repo", source: "kairoku.json" as const };
    await Promise.all([1, 2, 3, 4].map(() => runQa("/wt", { plan: two, exec: slow })));
    expect(peak).toBe(2);
  });

  test("the semaphore is PER REPO — two repos that both said 2 are two queues, not one", async () => {
    // Keyed by the limit alone, a daemon holding two repos would serialise them
    // against each other and halve the throughput each repo asked for.
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(20);
      inFlight--;
      return { code: 0, stdout: " 1 pass\n 0 fail\n", stderr: "" };
    };
    const one = { check: [], test: "bun test", concurrency: 1, source: "kairoku.json" as const };
    await Promise.all([
      runQa("/a", { plan: { ...one, key: "owner/a" }, exec: slow }),
      runQa("/b", { plan: { ...one, key: "owner/b" }, exec: slow }),
    ]);
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

// ------------------------------------------------------- §21 layer two: the gate

describe("qa — §21 layer two: the repo's own rules, before the check commands", () => {
  const plan: QaPlan = { check: ["true"], test: "bun test", concurrency: 1, key: "owner/repo", source: "kairoku.json" };
  const green = async () => ({ code: 0, stdout: " 10 pass\n 0 fail\n", stderr: "" });

  test("a match fails QA with the rule ids and file:line, BEFORE anything else runs", async () => {
    const ran: string[] = [];
    const result = await runQa("/wt", {
      plan,
      exec: async (command) => {
        ran.push(command);
        return green();
      },
      scan: async () => ({
        ok: true,
        matches: [
          { ruleId: "bun-spawn-resolved-path", file: "src/a.ts", line: 12, message: "resolve it first", note: "CLI PR #7" },
          { ruleId: "mock-module-self-delegating", file: "src/b.test.ts", line: 4, message: "capture by value" },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
    expect(result.summary).toContain("2");
    expect(result.defect).toContain("bun-spawn-resolved-path");
    expect(result.defect).toContain("src/a.ts:12");
    expect(result.defect).toContain("mock-module-self-delegating");
    expect(result.defect).toContain("src/b.test.ts:4");
    expect(result.counts).toBeUndefined();
  });

  test("no match runs the rest of QA exactly as before", async () => {
    const ran: string[] = [];
    const result = await runQa("/wt", {
      plan,
      exec: async (command) => {
        ran.push(command);
        return green();
      },
      scan: async () => ({ ok: true, matches: [] }),
    });
    expect(ran).toEqual(["true", "bun test"]);
    expect(result).toMatchObject({ ok: true, counts: { pass: 10, fail: 0, skip: 0, errors: 0 } });
  });

  test("a scan this daemon cannot read FAILS QA — it may not report clean without having looked", async () => {
    const result = await runQa("/wt", {
      plan,
      exec: green,
      scan: async () => ({ ok: false, error: "ast-grep printed no result this daemon can read" }),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("rules");
    expect(result.defect).toContain("ast-grep");
  });

  test("a repo with no rules never scans, and QA is unchanged", async () => {
    const result = await runQa("/wt", { plan: { ...plan, check: [] }, exec: green });
    expect(result).toMatchObject({ ok: true, counts: { pass: 10, fail: 0, skip: 0, errors: 0 } });
  });
});
