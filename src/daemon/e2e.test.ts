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
 *
 * O-4 moved `kairoku.json` to the COMMITTED base branch, so the fixture repo
 * here is a real git repository with a real commit on `origin/main`, and the
 * worktrees carry only the runner the manifest points at.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appClient, type RunReport } from "./app";
import { postToolUseHook } from "./providers/claude";
import { RULES_PATH } from "./rules";
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
 * §21 — rule 3, exactly as this repo dogfoods it. Read from THIS checkout so the
 * e2e cannot drift from the rule the daemon would actually be handed.
 */
const RULE_3 = readFileSync(
  join(import.meta.dir, "..", "..", RULES_PATH, "bun-spawn-resolved-path.yml"),
  "utf8",
);

/** Same commands, plus nothing: the rules gate needs no manifest entry. */
const RULED_MANIFEST = JSON.stringify({ check: [], test: "sh ./run-tests.sh", concurrency: { test: 1 } });

/** The manifest the fixture repo commits to its base branch. */
const FIXTURE_MANIFEST = JSON.stringify({
  check: ["true"],
  test: "sh ./run-tests.sh",
  concurrency: { test: 4 },
});

/**
 * Worktrees that carry a real test runner, so the QA step runs a real command
 * and parses a real summary. The runner fails its first invocation per worktree
 * and passes afterwards, which is what a fix loop looks like from the outside.
 * The MANIFEST is not written here — it lives on the base branch (O-4).
 */
function seedingWorktrees(root: string, failFirstFor: (name: string) => boolean) {
  const base = fakeWorktrees(root);
  return {
    ...base,
    async create(name: string, from?: string) {
      const worktree = await base.create(name, from);
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

/**
 * A real checkout with a real commit on `origin/main`: the daemon reads the
 * manifest from the branch, so a fixture without one would exercise nothing.
 */
async function machine(overrides: Record<string, unknown> = {}, manifest = FIXTURE_MANIFEST) {
  app = fakeApp();
  const h = (active = harness({ ...overrides, appUrl: app.url, token: app.token }));
  mkdirSync(h.config.repoPath, { recursive: true });
  const repo = h.config.repoPath;
  await git(["git", "init", "-q", "-b", "main"], repo);
  await git(["git", "config", "user.email", "daemon@example.com"], repo);
  await git(["git", "config", "user.name", "daemon"], repo);
  await git(["git", "remote", "add", "origin", "https://github.com/owds-inc/kairoku.git"], repo);
  writeFileSync(join(repo, "kairoku.json"), manifest);
  await git(["git", "add", "-A"], repo);
  await git(["git", "commit", "-qm", "the environment contract"], repo);
  await git(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);
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
    "two overlapping dispatches never put more members on the machine than it has slots",
    async () => {
      // The claim loop refuses only when NOTHING is free, so one spare slot is
      // enough to claim a three-item dispatch on top of a running one. Capacity
      // therefore has to be enforced where a member actually starts, not by the
      // fan-out's own bound.
      fakeGhOnPath();
      const { h, app: fake } = await machine({ maxConcurrent: 2 });
      const provider = scriptedTeam();
      provider.paused = true;
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const store = new RunStore(config);

      const l = (link = startLink(store, config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      expect(await l.beat()).toBeGreaterThan(0);

      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, store.capacity().running);
      }, 2);

      try {
        fake.queue({
          id: "d-first",
          taskType: "implement",
          target: { kind: "plan_item", id: "t1", title: "one" },
          repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
          team: { recipe: "build-verify", roles: {} },
          items: [fakeItem(1)],
        });
        expect(await l.poll()).toBe(true);
        await waitFor(() => store.list().length === 1, "the first dispatch's member");

        // One slot free, so the app hands over a THREE-item dispatch.
        fake.queue({
          id: "d-second",
          taskType: "implement",
          target: { kind: "phase", id: "ph2", title: "Phase two" },
          repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
          team: { recipe: "phase-team", roles: {} },
          items: [4, 5, 6].map((n) => fakeItem(n, { runId: `b-run-${n}` })),
        });
        expect(await l.poll()).toBe(true);
        await Bun.sleep(80);
        expect(store.capacity()).toEqual({ running: 2, max: 2 });

        provider.resume();
        await waitFor(
          () => [...fake.runs.values()].every((row) => row.status === "done" || row.status === "failed"),
          "all four members to settle",
          30_000,
        );
        await l.beat();
      } finally {
        clearInterval(sampler);
      }

      // Never over the line, and nobody starved: all four ran and finished.
      expect(peak).toBeLessThanOrEqual(2);
      expect([...fake.runs.keys()].sort()).toEqual(["b-run-4", "b-run-5", "b-run-6", "run-1"]);
      for (const [runId, row] of fake.runs) expect({ [runId]: row.status }).toEqual({ [runId]: "done" });
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

  test(
    "§23.2 — a run's curated events reach the app over update, off the heartbeat entirely",
    async () => {
      const { h, app: fake } = await machine({ maxConcurrent: 1 });
      const provider = scriptedTeam();
      provider.paused = true; // held mid-turn, so its events are sitting there to flush
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
        id: "d-flush",
        taskType: "implement",
        target: { kind: "phase", id: "ph1", title: "Phase one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "solo" },
        items: [fakeItem(1)],
      });
      expect(await l.poll()).toBe(true);
      await waitFor(() => store.list().length === 1, "the run to start");
      await Bun.sleep(30);

      // No heartbeat since the setup beat — flush is the only thing that ran.
      const beatsBefore = fake.calls.filter((c) => c.route === "heartbeat").length;
      await l.flush();
      expect(fake.calls.filter((c) => c.route === "heartbeat").length).toBe(beatsBefore);

      const update = fake.calls.filter((c) => c.route === "update").at(-1)!.body as RunReport;
      expect(update).toMatchObject({ dispatchId: "d-flush", runId: "run-1", status: "running" });
      expect(update.events!.some((e) => e.kind === "text")).toBe(true);

      provider.resume();
      await waitFor(() => fake.runs.get("run-1")?.status !== undefined, "the run to settle", 30_000);
    },
    30_000,
  );
});

/**
 * §21 — the two layers, end to end, over a fixture repo whose BASE BRANCH
 * carries rule 3. Nothing here is stubbed but the model: the rules are read
 * from `origin/main` by the production reader, materialised by the production
 * materialiser, and checked by the real `ast-grep` binary on this machine.
 */
describe("the two layers of §21, against a base branch that declares a rule", () => {
  const violating = [
    "export async function findPr(repo: string) {",
    '  const gh = Bun.which("gh");',
    "  if (!gh) return;",
    '  return Bun.spawn(["gh", "pr", "view"], { cwd: repo });',
    "}",
    "",
  ].join("\n");

  /** The base branch carries the rule; the worktrees never do. */
  async function ruledMachine() {
    const made = await machine({ maxConcurrent: 1 }, RULED_MANIFEST);
    const repo = made.h.config.repoPath;
    mkdirSync(join(repo, RULES_PATH), { recursive: true });
    writeFileSync(join(repo, RULES_PATH, "bun-spawn-resolved-path.yml"), RULE_3);
    await git(["git", "add", "-A"], repo);
    await git(["git", "commit", "-qm", "the repo's own rules"], repo);
    await git(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);
    return made;
  }

  /**
   * An implementer that writes a violating file. `viaHook` decides whether the
   * PRODUCTION `PostToolUse` hook sees the write — layer one — or whether the
   * violation slips past it and has to be caught by QA — layer two.
   */
  function writer(options: { viaHook: boolean }) {
    const blocks: string[] = [];
    const prompts: string[] = [];
    const provider: Provider & { blocks: string[]; prompts: string[] } = {
      name: "claude",
      blocks,
      prompts,
      models: async () => ["claude-opus-5"],
      launch(run: RoleRun): LaunchedRun {
        prompts.push(run.prompt);
        const work = (async () => {
          if (run.role !== "implementer") return;
          // Round two of the fix loop repairs it, so the member can finish.
          const fixing = run.prompt.includes("did not pass");
          const file = join(run.cwd, "src", "pr.ts");
          mkdirSync(join(run.cwd, "src"), { recursive: true });
          writeFileSync(file, fixing ? violating.replace('["gh",', "[gh,") : violating);
          if (!options.viaHook || fixing) return;
          const answer = await postToolUseHook(run)({ tool_name: "Write", tool_input: { file_path: file } });
          if (answer.decision === "block") blocks.push(String(answer.reason));
        })();
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              await work;
              yield { kind: "text" as const, text: `${run.role} ran` };
            },
          },
          interrupt() {},
          exit: work.then(() => ({
            ok: true,
            summary: `${run.role} finished`,
            ...(run.role === "reviewer" ? { report: { verdict: "CLEAN", defects: [] } } : {}),
          })),
        };
      },
    };
    return provider;
  }

  test.if(Boolean(Bun.which("ast-grep", { PATH: process.env.PATH ?? "" })))(
    "layer one: the write is BLOCKED with the rule's message and the defect it exists for",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await ruledMachine();
      const provider = writer({ viaHook: true });
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const l = (link = startLink(new RunStore(config), config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      await l.beat();
      fake.queue({
        id: "d-rules",
        taskType: "implement",
        target: { kind: "plan_item", id: "t1", title: "one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "build-verify", roles: {} },
        items: [fakeItem(1)],
      });
      expect(await l.poll()).toBe(true);
      await waitFor(
        () => [...fake.runs.values()].every((r) => r.status === "done" || r.status === "failed"),
        "the member to settle",
        60_000,
      );
      expect(provider.blocks).toHaveLength(1);
      expect(provider.blocks[0]).toContain("bun-spawn-resolved-path");
      expect(provider.blocks[0]).toContain("src/pr.ts:4");
      expect(provider.blocks[0]).toContain("Bun.spawn must run the path");
      expect(provider.blocks[0]).toContain("PR #7 defect 5");
    },
    90_000,
  );

  test.if(Boolean(Bun.which("ast-grep", { PATH: process.env.PATH ?? "" })))(
    "layer two: a violation that slipped past the hook FAILS QA, and the fix loop's next prompt carries it",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await ruledMachine();
      const provider = writer({ viaHook: false });
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const l = (link = startLink(new RunStore(config), config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      await l.beat();
      fake.queue({
        id: "d-qa",
        taskType: "implement",
        target: { kind: "plan_item", id: "t1", title: "one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "build-verify", roles: {} },
        items: [fakeItem(1)],
      });
      expect(await l.poll()).toBe(true);
      await waitFor(
        () => [...fake.runs.values()].every((r) => r.status === "done" || r.status === "failed"),
        "the member to settle",
        60_000,
      );
      // Nothing blocked at the write, so QA is what caught it — and the
      // implementer's next turn was given the rule id and the file:line.
      expect(provider.blocks).toEqual([]);
      const fix = provider.prompts.find((p) => p.includes("did not pass"));
      expect(fix).toBeDefined();
      expect(fix).toContain("bun-spawn-resolved-path");
      expect(fix).toContain("src/pr.ts:4");
      // The fix round repaired it, so the run finished green on the repo's suite.
      expect(fake.runs.get("run-1")!.status).toBe("done");
      expect(fake.runs.get("run-1")!.counts).toEqual({ pass: 10, fail: 0, skip: 0, errors: 0 });
    },
    90_000,
  );

  test.if(Boolean(Bun.which("ast-grep", { PATH: process.env.PATH ?? "" })))(
    "the rule survives a worktree that deletes it — it is read from the base branch",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await ruledMachine();
      const inner = writer({ viaHook: false });
      const deleting: Provider = {
        ...inner,
        launch(run: RoleRun): LaunchedRun {
          // The PR's own first act is to delete the rules directory it is
          // about to violate. The daemon never read that copy.
          rmSync(join(run.cwd, ".kairoku"), { recursive: true, force: true });
          return inner.launch(run);
        },
      };
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const l = (link = startLink(new RunStore(config), config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: deleting, codex: deleting },
      }));
      await l.beat();
      fake.queue({
        id: "d-del",
        taskType: "implement",
        target: { kind: "plan_item", id: "t1", title: "one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "build-verify", roles: {} },
        items: [fakeItem(1)],
      });
      expect(await l.poll()).toBe(true);
      await waitFor(
        () => [...fake.runs.values()].every((r) => r.status === "done" || r.status === "failed"),
        "the member to settle",
        60_000,
      );
      // The rule the worktree deleted is still the one that caught it: QA
      // failed on it and the fix round was handed its id and file:line.
      const fix = inner.prompts.find((p) => p.includes("did not pass"));
      expect(fix).toBeDefined();
      expect(fix).toContain("bun-spawn-resolved-path");
      expect(fix).toContain("src/pr.ts:4");
    },
    90_000,
  );
});

/**
 * §23.4's done-condition, end to end: a scripted provider's tool call, its
 * RESULT and the run's PHASE markers reach the fake app, in seq order, over the
 * real link and the real recipe. Nothing here talks to the real app.
 */
describe("the run transcript reaches the app (§23.4)", () => {
  test(
    "tool → result → phase arrive in order, and the whole log is one seq-ordered stream",
    async () => {
      fakeGhOnPath();
      const { h, app: fake } = await machine();
      const provider: Provider = {
        name: "claude",
        models: async () => ["claude-opus-5"],
        launch(run: RoleRun): LaunchedRun {
          return {
            events: {
              async *[Symbol.asyncIterator]() {
                yield { kind: "text" as const, text: `${run.role} is on it` };
                yield { kind: "tool" as const, text: 'Bash {"command":"bun test"}' };
                yield { kind: "result" as const, text: "ok 1832ms 615 pass" };
              },
            },
            interrupt() {},
            exit: Promise.resolve({
              ok: true,
              summary: `${run.role} finished`,
              ...(run.role === "reviewer" ? { report: { verdict: "CLEAN", defects: [] } } : {}),
            }),
          };
        },
      };
      const config = { ...h.config, worktreeOps: seedingWorktrees(h.config.worktreesDir, () => false) };
      const l = (link = startLink(new RunStore(config), config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      await l.beat();
      fake.queue({
        id: "d-transcript",
        taskType: "implement",
        target: { kind: "plan_item", id: "t1", title: "one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "build-verify", roles: {} },
        items: [fakeItem(1)],
      });
      expect(await l.poll()).toBe(true);
      // Curated lines travel only while a run is LIVE (RF-020's flush, or a
      // beat) — a terminal report carries none. So the beat is driven here the
      // way the 2 s flush drives it in production, serially so the batches
      // cannot interleave.
      let settled = false;
      const beating = (async () => {
        while (!settled) {
          await l.beat();
          await Bun.sleep(5);
        }
      })();
      await waitFor(
        () => [...fake.runs.values()].every((r) => r.status === "done" || r.status === "failed"),
        "the member to settle",
        60_000,
      );
      settled = true;
      await beating;

      const events = fake.runs.get("run-1")!.events;
      expect(fake.runs.get("run-1")!.status).toBe("done");
      expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));

      // The pair the app folds into one tool card, in the order it folds them.
      const tool = events.findIndex((e) => e.kind === "tool");
      expect(tool).toBeGreaterThanOrEqual(0);
      expect(events[tool + 1]).toMatchObject({ kind: "result", text: "ok 1832ms 615 pass" });

      // The dividers, and the one that closes the run.
      expect(events.filter((e) => e.kind === "phase").map((e) => e.text)).toEqual([
        "implementing",
        "reviewing",
        "qa",
        "done",
      ]);
      // A phase always precedes the turn it names.
      expect(events.findIndex((e) => e.kind === "phase")).toBeLessThan(events.findIndex((e) => e.kind === "text"));
    },
    90_000,
  );
});
