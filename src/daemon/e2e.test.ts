/**
 * THE DONE-CONDITION, run for real.
 *
 * Everything in this file is production code except three things, and each of
 * them is a thing that cannot exist in a test on principle: the APP is the fake
 * one (`Bun.serve` speaking the three routes with the shapes
 * `bikerwhocodes/kairoku@eab363ea` answers), the MODEL is a scripted provider,
 * and `gh` is a shell script on PATH that prints a pull-request url. The link,
 * the claim, the recipe, the fix loops, the deterministic QA step with its real
 * runner output, the curated events, the reports and the cancel are the ones
 * that ship.
 *
 * A run against the real app needs a browser-minted daemon token, so that is a
 * human gate rather than a test — it is listed in the PR body.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appClient, type RunReport } from "./app";
import { startLink, type Link } from "./link";
import type { LaunchedRun, Provider, RoleRun } from "./providers";
import { RunStore } from "./runs";
import { fakeApp, fakeItem, fakeWorktrees, harness, waitFor, type FakeApp, type Harness } from "./testkit";
import { run as git } from "./worktree";

let active: Harness | undefined;
let app: FakeApp | undefined;
let link: Link | undefined;
let binDir: string | undefined;
let pathBefore: string | undefined;

afterEach(async () => {
  link?.stop();
  link = undefined;
  await app?.stop();
  app = undefined;
  active?.cleanup();
  active = undefined;
  if (pathBefore !== undefined) process.env.PATH = pathBefore;
  pathBefore = undefined;
  if (binDir) rmSync(binDir, { recursive: true, force: true });
  binDir = undefined;
});

const PR = "https://github.com/owds-inc/kairoku/pull/42";

/** A real `gh` on PATH that answers `pr view` with a url. No network, no auth. */
function fakeGhOnPath(): void {
  binDir = mkdtempSync(join(tmpdir(), "kairoku-bin-"));
  const gh = join(binDir, "gh");
  writeFileSync(gh, `#!/bin/sh\necho "${PR}"\n`);
  chmodSync(gh, 0o755);
  // glab must not answer first, so it is shadowed by a script that fails.
  const glab = join(binDir, "glab");
  writeFileSync(glab, "#!/bin/sh\nexit 1\n");
  chmodSync(glab, 0o755);
  pathBefore = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

/**
 * Worktrees that carry a real repo manifest and a real test runner, so the QA
 * step runs a real command and parses a real summary. The runner fails its
 * first invocation per worktree and passes afterwards, which is what a fix loop
 * looks like from the outside.
 */
function seedingWorktrees(root: string, failFirstFor: (name: string) => boolean) {
  const base = fakeWorktrees(root);
  return {
    ...base,
    async create(name: string, from?: string) {
      const worktree = await base.create(name, from);
      writeFileSync(
        join(worktree.path, "kairoku.json"),
        JSON.stringify({ check: ["true"], test: "sh ./run-tests.sh", concurrency: { test: 4 } }),
      );
      writeFileSync(
        join(worktree.path, "run-tests.sh"),
        failFirstFor(name)
          ? [
              "#!/bin/sh",
              'if [ -f .ran ]; then printf " 10 pass\\n 0 fail\\n"; exit 0; fi',
              'touch .ran; printf " 8 pass\\n 2 fail\\n"; echo "expected true to be false at a.test.ts:12"; exit 1',
            ].join("\n")
          : '#!/bin/sh\nprintf " 10 pass\\n 0 fail\\n"\n',
      );
      return worktree;
    },
  };
}

/**
 * The team, scripted per ITEM rather than per role: item 1 goes through a
 * reviewer fix loop, item 2 through a QA fix loop, item 3 straight through.
 */
function scriptedTeam(): Provider & { launched: RoleRun[]; holdItem3: boolean; paused: boolean; resume(): void } {
  const reviewsSeen = new Map<string, number>();
  const gates = new Set<() => void>();
  const provider = {
    name: "claude" as const,
    launched: [] as RoleRun[],
    holdItem3: false,
    /** Hold every turn, so the test can beat while three members are live. */
    paused: false,
    resume() {
      provider.paused = false;
      for (const open of [...gates]) open();
      gates.clear();
    },
    models: async () => ["claude-opus-5", "claude-sonnet-5"],
    launch(run: RoleRun): LaunchedRun {
      provider.launched.push(run);
      const item = run.prompt.match(/Item (\d)/)?.[1] ?? "?";

      let report: unknown;
      if (run.role === "reviewer") {
        const seen = (reviewsSeen.get(item) ?? 0) + 1;
        reviewsSeen.set(item, seen);
        report =
          item === "1" && seen === 1
            ? { verdict: "NOT_CLEAN", defects: ["src/one.ts:12 — the guard passes when it cannot tell"] }
            : { verdict: "CLEAN", defects: [] };
      }

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding =
        provider.paused || (provider.holdItem3 && item === "3" && run.role === "implementer");
      if (holding) gates.add(release);
      let interrupted = false;

      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { kind: "text" as const, text: `${run.role} on item ${item}` };
            yield { kind: "tool" as const, text: `Bash {"command":"bun test"}` };
            if (holding) await held;
          },
        },
        interrupt() {
          interrupted = true;
          gates.delete(release);
          release();
        },
        exit: (async () => {
          if (holding) await held;
          if (interrupted) return { ok: false, summary: "interrupted" };
          return { ok: true, summary: `${run.role} finished`, ...(report === undefined ? {} : { report }) };
        })(),
      };
    },
  };
  return provider;
}

async function machine(overrides: Record<string, unknown> = {}) {
  app = fakeApp();
  const h = (active = harness({ ...overrides, appUrl: app.url, token: app.token }));
  mkdirSync(h.config.repoPath, { recursive: true });
  await git(["git", "init", "-q"], h.config.repoPath);
  await git(["git", "remote", "add", "origin", "https://github.com/owds-inc/kairoku.git"], h.config.repoPath);
  return { h, app: app! };
}

describe("the done-condition, against the fake app", () => {
  test(
    "a phase-team of three on a capacity-2 machine: two at once, a reviewer loop, a QA loop, PRs and counts",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await machine({ maxConcurrent: 2 });
      const provider = scriptedTeam();
      provider.paused = true;
      // Item 2's suite fails once, then passes: the QA fix loop, for real.
      const worktrees = seedingWorktrees(h.config.worktreesDir, (name) => name.endsWith("-2"));
      const config = { ...h.config, worktreeOps: worktrees };
      const store = new RunStore(config);
      const logs: string[] = [];

      const l = (link = startLink(store, config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: (line) => logs.push(line),
        providers: { claude: provider, codex: provider },
      }));

      // The machine says hello: repos, models and recipes are what the composer
      // greys its dropdowns against.
      expect(await l.beat()).toBeGreaterThan(0);
      const meta = fake.metas[0];
      expect(meta.repos).toEqual(["owds-inc/kairoku"]);
      expect(meta.providers.claude).toEqual(["claude-opus-5", "claude-sonnet-5"]);
      expect(meta.recipes).toContain("phase-team");
      expect(meta.capacity).toEqual({ running: 0, max: 2 });

      fake.queue({
        id: "d-phase",
        taskType: "implement",
        target: { kind: "phase", id: "ph1", title: "Phase one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "phase-team", roles: { implementer: { provider: "claude", model: "claude-opus-5" } } },
        items: [fakeItem(1), fakeItem(2), fakeItem(3)],
      });

      expect(await l.poll()).toBe(true);
      await waitFor(() => store.list().length === 2, "two members at once");
      expect(store.capacity()).toEqual({ running: 2, max: 2 });

      // A beat while they work: the events reach the app, and the cadence is
      // the fast one (grill Q6) because something is running.
      await Bun.sleep(30);
      expect(await l.beat()).toBe(10_000);
      const live = (fake.calls.at(-1)!.body as { runs?: RunReport[] }).runs ?? [];
      expect(live.map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);
      expect(live[0]!.events!.some((e) => e.kind === "text")).toBe(true);

      provider.resume();
      await waitFor(
        () => [...fake.runs.values()].every((row) => row.status === "done" || row.status === "failed"),
        "all three members to settle",
        30_000,
      );
      await l.beat();

      // Every run finished done, with a branch, the PR url and all four counts.
      for (const [runId, row] of fake.runs) {
        expect({ [runId]: row.status }).toEqual({ [runId]: "done" });
        expect(row.counts).toEqual({ pass: 10, fail: 0, skip: 0, errors: 0 });
        expect((row.artifacts as { prUrl?: string }).prUrl).toBe(PR);
        expect((row.artifacts as { branch?: string }).branch).toMatch(/^run\/d-phase-\d$/);
      }

      // Item 1 went round the REVIEWER loop: two reviews and a second
      // implementer turn carrying the defect verbatim.
      const item1 = provider.launched.filter((r) => r.prompt.includes("Item 1"));
      expect(item1.map((r) => r.role)).toEqual(["implementer", "reviewer", "implementer", "reviewer"]);
      expect(item1[2]!.prompt).toContain("src/one.ts:12 — the guard passes when it cannot tell");

      // Item 2 went round the QA loop: one review, then a second implementer
      // turn carrying the runner's own failure tail.
      const item2 = provider.launched.filter((r) => r.prompt.includes("Item 2"));
      expect(item2.map((r) => r.role)).toEqual(["implementer", "reviewer", "implementer"]);
      expect(item2[2]!.prompt).toContain("expected true to be false at a.test.ts:12");

      // Item 3 went straight through.
      expect(provider.launched.filter((r) => r.prompt.includes("Item 3")).map((r) => r.role)).toEqual([
        "implementer",
        "reviewer",
      ]);

      // The run detail shows the events, in seq order, masked and curated.
      const events = fake.runs.get("run-1")!.events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
      expect(events.some((e) => e.kind === "tool" && e.text.startsWith("Bash "))).toBe(true);
      expect(JSON.stringify(events)).not.toContain("kai_run_token_1");

      // Idle again: the cadence falls back to what the app asked for.
      expect(await l.beat()).toBe(30_000);
    },
    60_000,
  );

  test(
    "cancelling one run interrupts only that member, within one beat",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await machine({ maxConcurrent: 3 });
      const provider = scriptedTeam();
      provider.holdItem3 = true;
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const store = new RunStore(config);

      const l = (link = startLink(store, config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      await l.beat();

      fake.queue({
        id: "d-cancel",
        taskType: "implement",
        target: { kind: "phase", id: "ph1", title: "Phase one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "phase-team" },
        items: [fakeItem(1), fakeItem(2), fakeItem(3)],
      });
      expect(await l.poll()).toBe(true);
      await waitFor(() => store.list().some((r) => r.runId === "run-3"), "member three to start");

      // The app decides to stop member three, and says so on the next beat.
      fake.cancel.push({ dispatchId: "d-cancel", runId: "run-3" });
      await l.beat();

      await waitFor(() => fake.runs.get("run-3")?.status === "failed", "the cancelled member to settle");
      expect(fake.runs.get("run-3")!.summary).toBe("cancelled by the app");

      // Its siblings finished on their own, untouched.
      await waitFor(
        () => ["run-1", "run-2"].every((id) => fake.runs.get(id)?.status === "done"),
        "the other two to finish",
        30_000,
      );
      const cancelledReports = [...fake.runs.values()].filter((r) => r.summary === "cancelled by the app");
      expect(cancelledReports).toHaveLength(1);
    },
    60_000,
  );
});
