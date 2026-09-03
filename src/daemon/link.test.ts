/**
 * RF-012 — the loop, against the fake app.
 *
 * The three timers are split from their policy on purpose: `beat()`, `poll()`
 * and `flush()` are each one turn of the loop and each returns what the
 * scheduler needs, so every rule below is asserted without waiting out a real
 * 30-second cadence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { appClient, type RunReport } from "./app";
import { run as git } from "./worktree";
import { startLink, ACTIVE_HEARTBEAT_MS, BACKOFF_START_MS, BACKOFF_MAX_MS, type Link } from "./link";
import { pendingReports, readRunStates, runStatePath, writeRunState } from "./dispatch";
import { EVENTS_PER_REPORT_MAX } from "./events";
import { RunStore } from "./runs";
import {
  fakeApp,
  fakeItem,
  fakeProvider,
  harness,
  stubExec,
  waitFor,
  type FakeApp,
  type FakeProvider,
  type Harness,
} from "./testkit";

let active: Harness | undefined;
let app: FakeApp | undefined;
let link: Link | undefined;

afterEach(async () => {
  link?.stop();
  link = undefined;
  await app?.stop();
  app = undefined;
  active?.cleanup();
  active = undefined;
});

function setup(overrides: Record<string, unknown> = {}, appOptions = {}) {
  app = fakeApp(appOptions);
  const h = (active = harness({ ...overrides, appUrl: app.url, token: app.token }));
  const store = new RunStore(h.config);
  const logs: string[] = [];
  const provider = scripted();
  link = startLink(store, h.config, {
    client: appClient({ appUrl: app.url, token: h.config.token! }),
    autostart: false,
    log: (line) => logs.push(line),
    providers: { claude: provider, codex: provider },
  });
  return { h, store, link: link!, app: app!, logs, provider };
}

/**
 * A real checkout whose `origin` names `full`, so the §20.9 guard has the
 * left-hand side production actually derives (`git remote get-url origin`).
 * The host is deliberately not a forge: `gh`/`glab` bail out at once.
 */
async function checkoutOf(path: string, full: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await git(["git", "init", "-q"], path);
  await git(["git", "remote", "add", "origin", `https://example.invalid/${full}.git`], path);
}

/**
 * A scripted team. Nothing in this repo may reach a real model, so a link that
 * will actually run a claim is given a fake provider for both names.
 */
function scripted(): FakeProvider {
  const provider = fakeProvider();
  provider.script("reviewer", [{ report: { verdict: "CLEAN", defects: [] } }]);
  provider.script("researcher", [{ report: { summary: "filed", documentIds: [] } }]);
  return provider;
}

/** A link over a harness whose checkout is already on disk (see `checkoutOf`). */
function linkTo(
  h: Harness,
  a: FakeApp,
  logs: string[],
  store = new RunStore(h.config),
  provider: FakeProvider = scripted(),
): Link {
  return (link = startLink(store, h.config, {
    client: appClient({ appUrl: a.url, token: a.token }),
    autostart: false,
    log: (line) => logs.push(line),
    providers: { claude: provider, codex: provider },
  }));
}

const claims = (a: FakeApp) => a.calls.filter((c) => c.route === "claim").length;
const beats = (a: FakeApp) => a.calls.filter((c) => c.route === "heartbeat").length;
const updates = (a: FakeApp) => a.calls.filter((c) => c.route === "update").map((c) => c.body as RunReport);

describe("the beat's meta (§20 item 2, grill Q21)", () => {
  test("protocol, host, version, capacity, repos and recipes travel every beat", async () => {
    const { link, app, h } = setup({ maxConcurrent: 3 }, { heartbeatIntervalMs: 7_000, protocol: "1" });
    await checkoutOf(h.config.repoPath, "owds-inc/kairoku");

    expect(await link.beat()).toBe(7_000);
    const meta = app.metas[0];
    expect(meta.protocol).toBe("1");
    expect(meta.capacity).toEqual({ running: 0, max: 3 });
    expect(meta.recipes).toContain("phase-team");
    expect(typeof meta.host).toBe("string");
    expect(link.status()).toMatchObject({ linked: true, liveness: "online", protocol: "1" });
  });

  test("the repos this machine holds are advertised, so the claim query can filter", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    await checkoutOf(h.config.repoPath, "owds-inc/kairoku");
    const logs: string[] = [];
    await linkTo(h, app!, logs).beat();
    expect(app.metas[0].repos).toEqual(["owds-inc/kairoku"]);
  });

  test("an unreadable checkout advertises nothing and warns once at boot", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    const logs: string[] = [];
    await linkTo(h, app!, logs).beat();
    expect(app.metas[0].repos).toEqual([]);
    expect(logs.some((l) => l.includes("advertises no repos"))).toBe(true);
  });

  test("an unlinked daemon does not dial out at all", async () => {
    const h = (active = harness({ appUrl: undefined, token: undefined }));
    const logs: string[] = [];
    const unlinked = (link = startLink(new RunStore(h.config), h.config, {
      autostart: false,
      log: (l) => logs.push(l),
    }));
    expect(await unlinked.beat()).toBe(30_000);
    expect(await unlinked.poll()).toBe(false);
    expect(unlinked.status().linked).toBe(false);
  });
});

describe("the cadence (grill Q6)", () => {
  test("10 s while a run is active, the app's own interval when nothing is", async () => {
    const { link, store, h } = setup({}, { heartbeatIntervalMs: 30_000 });
    expect(await link.beat()).toBe(30_000);

    void store.start({
      dispatchId: "d-live",
      runId: "d-live",
      name: "d-live",
      execute: stubExec(["sh", "-c", "sleep 30"]),
    });
    await waitFor(() => store.capacity().running === 1, "a live run");
    expect(await link.beat()).toBe(ACTIVE_HEARTBEAT_MS);

    await store.shutdown();
    expect(await link.beat()).toBe(30_000);
    expect(h.worktrees.removed).toHaveLength(1);
  });

  test("an app asking for a faster cadence than 10 s is obeyed, not overridden", async () => {
    const { link, store } = setup({}, { heartbeatIntervalMs: 2_000 });
    void store.start({
      dispatchId: "d-fast",
      runId: "d-fast",
      name: "d-fast",
      execute: stubExec(["sh", "-c", "sleep 30"]),
    });
    await waitFor(() => store.capacity().running === 1, "a live run");
    expect(await link.beat()).toBe(2_000);
    await store.shutdown();
  });
});

describe("backoff (RF-012)", () => {
  test("5xx backs off 30 s doubling to a 5 min cap, and a success resets it", async () => {
    const { link, app } = setup();
    app.failWith = 503;
    let wait = await link.beat();
    expect(wait).toBe(BACKOFF_START_MS);
    for (let i = 0; i < 10; i++) wait = await link.beat();
    expect(wait).toBe(BACKOFF_MAX_MS);

    app.failWith = 0;
    expect(await link.beat()).toBe(30_000);
    app.failWith = 503;
    expect(await link.beat()).toBe(BACKOFF_START_MS);
  });

  test("an unreachable app backs off the same way rather than throwing", async () => {
    const h = (active = harness({ appUrl: "http://127.0.0.1:1", token: "t" }));
    const dead = (link = startLink(new RunStore(h.config), h.config, { autostart: false, log: () => {} }));
    expect(await dead.beat()).toBe(BACKOFF_START_MS);
    expect(dead.status().lastError).toContain("did not answer");
  });

  test("it never claims while a heartbeat is failing", async () => {
    const { link, app } = setup();
    app.failWith = 503;
    await link.beat();
    expect(await link.poll()).toBe(false);
    expect(claims(app)).toBe(0);
  });
});

describe("401 stops the loop and nothing else (RF-012)", () => {
  test("both timers stop, the message is exact, and the token is not in it", async () => {
    app = fakeApp({ token: "kai_the_right_token" });
    const h = (active = harness({ appUrl: app.url, token: "kai_the_wrong_token" }));
    const logs: string[] = [];
    const l = (link = startLink(new RunStore(h.config), h.config, {
      client: appClient({ appUrl: app.url, token: "kai_the_wrong_token" }),
      autostart: false,
      log: (line) => logs.push(line),
    }));

    expect(await l.beat()).toBe(0);
    expect(l.status().stopped).toBe("token-rejected");
    expect(logs.join("\n")).toContain("the loop is stopped");
    expect(logs.join("\n")).not.toContain("kai_the_wrong_token");

    const before = beats(app);
    expect(await l.beat()).toBe(0);
    expect(await l.poll()).toBe(false);
    expect(beats(app)).toBe(before);
  });
});

describe("claiming", () => {
  test("a full daemon does not claim; a freed slot does", async () => {
    const { link, store, app } = setup({ maxConcurrent: 1 });
    await link.beat();
    const running = store.start({
      dispatchId: "d-busy",
      runId: "d-busy",
      name: "d-busy",
      execute: stubExec(["sh", "-c", "sleep 30"]),
    });
    await waitFor(() => store.free() === 0, "the slot to be taken");
    expect(await link.poll()).toBe(false);
    expect(claims(app)).toBe(0);

    await store.shutdown();
    await running;
    expect(await link.poll()).toBe(false); // the queue is empty, but it asked
    expect(claims(app)).toBe(1);
  });

  test("an empty queue is a poll that took nothing, not a failure", async () => {
    const { link, app } = setup();
    await link.beat();
    expect(await link.poll()).toBe(false);
    expect(link.status().lastError).toBeUndefined();
    expect(claims(app)).toBe(1);
  });

  test("the same dispatch id handed out twice is run once", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token, maxConcurrent: 4 }));
    await checkoutOf(h.config.repoPath, "owds-inc/kairoku");
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    const dispatch = {
      id: "d-twice",
      taskType: "implement" as const,
      items: [fakeItem(1)],
      repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
    };
    app.queue(dispatch);
    app.queue(dispatch);

    expect(await l.poll()).toBe(true);
    expect(await l.poll()).toBe(false);
    expect(logs.join("\n")).toContain("ignoring a second claim of d-twice");
  });
});

describe("the reports the app gets", () => {
  test("every run says running at launch and terminal at the end, both with the run id", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    await checkoutOf(h.config.repoPath, "owds-inc/kairoku");
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    app.queue({
      id: "d-report",
      taskType: "research",
      items: [fakeItem(1)],
      repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
      team: { recipe: "research" },
    });
    expect(await l.poll()).toBe(true);
    await waitFor(() => app!.runs.get("run-1")?.status === "done", "the run to settle");

    const sent = updates(app!);
    expect(sent[0]).toMatchObject({ dispatchId: "d-report", runId: "run-1", status: "running", role: "researcher" });
    expect(sent.at(-1)).toMatchObject({ dispatchId: "d-report", runId: "run-1", status: "done" });
    expect(sent.at(-1)!.artifacts?.branch).toBe("run/d-report");
  });

  test("a terminal report the app could not take rides the next beat, and waits on disk", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);

    app.queue({ id: "d-queue", taskType: "research", items: [fakeItem(1)] });
    await fetch(`${app.url}/api/daemon/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
    });
    writeRunState(h.config.runsDir, {
      dispatchId: "d-queue",
      runId: "run-1",
      state: "done",
      startedAt: new Date().toISOString(),
      branch: "run/d-queue",
      report: { dispatchId: "d-queue", runId: "run-1", status: "done", summary: "filed" },
    });

    // The app is unwell: the beat fails, so the carried report is put back
    // untouched rather than lost.
    app.failWith = 503;
    expect(await l.beat()).toBe(BACKOFF_START_MS);
    expect(l.status().pendingReports).toBe(1);
    expect(pendingReports(h.config.runsDir)).toHaveLength(1);

    app.failWith = 0;
    await l.beat();
    expect(app.runs.get("run-1")).toMatchObject({ status: "done", summary: "filed" });
    expect(l.status().pendingReports).toBe(0);
  });
});

describe("a refusal the beat carries back is not dropped", () => {
  test("an {ok:false} in the beat's runs[] settles the row with a failed follow-up", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    const logs: string[] = [];
    const store = new RunStore(h.config);
    const l = linkTo(h, app!, logs, store);

    // A terminal report for a run the app has never heard of: it answers
    // {ok:false, reason:"not-found"} inside a 200 beat.
    writeRunState(h.config.runsDir, {
      dispatchId: "d-ghost",
      runId: "run-ghost",
      state: "done",
      startedAt: new Date().toISOString(),
      branch: "run/d-ghost",
      report: { dispatchId: "d-ghost", runId: "run-ghost", status: "done", summary: "green" },
    });

    await l.beat();

    expect(logs.join("\n")).toContain("the app refused the report for run run-ghost");
    // `doctor` must be able to name the run the last error came from.
    expect(l.status().lastError).toContain("run run-ghost");
    // The refused report is gone from disk; it is never retried into the same no.
    expect(pendingReports(h.config.runsDir)).toEqual([]);
    // One follow-up `failed` went out, carrying the reason.
    await waitFor(() => updates(app!).some((u) => u.runId === "run-ghost"), "the follow-up report");
    const followUp = updates(app!).find((u) => u.runId === "run-ghost");
    expect(followUp).toMatchObject({ status: "failed" });
    expect(followUp!.summary).toContain("refused");
    expect(followUp!.counts).toBeUndefined();
  });

  test("the outcome is paired by run id, not by position", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);

    // Two queued terminal reports: the first is real, the second is a ghost.
    app.queue({ id: "d-pair", taskType: "research", items: [fakeItem(1)] });
    await fetch(`${app.url}/api/daemon/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
    });
    for (const [dispatchId, runId] of [
      ["d-pair", "run-1"],
      ["d-pair", "run-ghost"],
    ]) {
      writeRunState(h.config.runsDir, {
        dispatchId: dispatchId!,
        runId: runId!,
        state: "done",
        startedAt: new Date().toISOString(),
        branch: "b",
        report: { dispatchId: dispatchId!, runId: runId!, status: "done", summary: "green" },
      });
    }

    await l.beat();
    // The GHOST was refused, not the real one — and the real row is `done`.
    expect(app.runs.get("run-1")!.status).toBe("done");
    expect(l.status().lastError).toContain("run-ghost");
  });
});

describe("cancel from the app (grill Q5)", () => {
  test("a cancel naming one run stops that run and leaves its siblings alone", async () => {
    const { link, store, app, logs } = setup({ maxConcurrent: 3 });
    await link.beat();
    const a = store.start({ dispatchId: "d1", runId: "r1", name: "r1", execute: stubExec(["sh", "-c", "sleep 30"]) });
    const b = store.start({ dispatchId: "d1", runId: "r2", name: "r2", execute: stubExec(["sh", "-c", "sleep 30"]) });
    await waitFor(() => store.list().length === 2, "two runs");

    app.cancel.push({ dispatchId: "d1", runId: "r1" });
    await link.beat();

    expect((await a).exitSummary).toBe("cancelled by the app");
    expect(store.list().map((r) => r.runId)).toEqual(["r2"]);
    expect(logs.join("\n")).toContain("cancelling run r1");
    await store.shutdown();
    await b;
  });

  test("a cancel naming only a dispatch stops every member of it", async () => {
    const { link, store, app } = setup({ maxConcurrent: 3 });
    await link.beat();
    const a = store.start({ dispatchId: "d1", runId: "r1", name: "r1", execute: stubExec(["sh", "-c", "sleep 30"]) });
    const b = store.start({ dispatchId: "d1", runId: "r2", name: "r2", execute: stubExec(["sh", "-c", "sleep 30"]) });
    const c = store.start({ dispatchId: "d2", runId: "r3", name: "r3", execute: stubExec(["sh", "-c", "sleep 30"]) });
    await waitFor(() => store.list().length === 3, "three runs");

    app.cancel.push({ dispatchId: "d1" });
    await link.beat();

    expect((await a).exitSummary).toBe("cancelled by the app");
    expect((await b).exitSummary).toBe("cancelled by the app");
    expect(store.list().map((r) => r.runId)).toEqual(["r3"]);
    await store.shutdown();
    await c;
  });

  test("a cancel for a run this daemon does not hold is ignored, not an error", async () => {
    const { link, app } = setup();
    app.cancel.push({ dispatchId: "nope", runId: "nope" });
    expect(await link.beat()).toBeGreaterThan(0);
    expect(link.status().lastError).toBeUndefined();
  });
});

describe("the curated events ride the beat (§20 item 7)", () => {
  test("a live run's lines are drained into its report and reach the app once", async () => {
    const { link, store, app } = setup();
    await link.beat();
    const running = store.start({
      dispatchId: "d-ev",
      runId: "r-ev",
      name: "r-ev",
      role: "implementer",
      execute: async (ctx) => {
        ctx.events.push("text", "reading the item");
        ctx.events.push("deny", "the reviewer may not use Write");
        await Bun.sleep(400);
        return { ok: true, summary: "done" };
      },
    });
    await waitFor(() => store.list().length === 1, "the run");
    await Bun.sleep(20);
    await link.beat();

    const row = app.runs.get("r-ev");
    expect(row).toBeUndefined(); // the app has no row for a run it never claimed
    const beat = app.calls.filter((c) => c.route === "heartbeat").at(-1)!.body as { runs?: RunReport[] };
    const report = beat.runs!.find((r) => r.runId === "r-ev")!;
    expect(report).toMatchObject({ dispatchId: "d-ev", role: "implementer", state: "running" });
    expect(report.events!.map((e) => e.kind)).toEqual(["text", "deny"]);

    // Drained: the same lines do not go up twice.
    await link.beat();
    const second = app.calls.filter((c) => c.route === "heartbeat").at(-1)!.body as { runs?: RunReport[] };
    expect(second.runs!.find((r) => r.runId === "r-ev")!.events).toBeUndefined();
    await store.shutdown();
    await running;
  });
});

describe("the flush timer (§23.2, DECISIONS.md — the Floor is live)", () => {
  test("a live run's events flush over update, off the heartbeat, within one tick", async () => {
    const { link, store, app } = setup();
    await link.beat();
    app.runs.set("r-flush", { dispatchId: "d-flush", taskType: "implement", status: "running", events: [] });
    const running = store.start({
      dispatchId: "d-flush",
      runId: "r-flush",
      name: "r-flush",
      role: "implementer",
      execute: async (ctx) => {
        ctx.events.push("text", "reading the item");
        ctx.events.push("tool", 'Bash {"command":"ls"}');
        await Bun.sleep(400);
        return { ok: true, summary: "done" };
      },
    });
    await waitFor(() => store.list().length === 1, "the run");
    await Bun.sleep(20);

    await link.flush();

    const updates = app.calls.filter((c) => c.route === "update");
    expect(updates).toHaveLength(1);
    const body = updates[0]!.body as RunReport;
    expect(body).toMatchObject({ dispatchId: "d-flush", runId: "r-flush", status: "running" });
    expect(body.events!.map((e) => e.kind)).toEqual(["text", "tool"]);
    // The flush rode `update`, never the heartbeat: only the setup beat happened.
    expect(app.calls.filter((c) => c.route === "heartbeat")).toHaveLength(1);

    // Drained: a second flush with nothing new sends nothing.
    await link.flush();
    expect(app.calls.filter((c) => c.route === "update")).toHaveLength(1);

    await store.shutdown();
    await running;
  });

  test("no active run: the flush is a no-op", async () => {
    const { link, app } = setup();
    await link.beat();
    await link.flush();
    expect(app.calls.filter((c) => c.route === "update")).toHaveLength(0);
  });

  test("a failed flush keeps the events for the next tick — nothing is lost", async () => {
    const { link, store, app } = setup();
    await link.beat();
    app.runs.set("r-retry", { dispatchId: "d-retry2", taskType: "implement", status: "running", events: [] });
    const running = store.start({
      dispatchId: "d-retry2",
      runId: "r-retry",
      name: "r-retry",
      execute: async (ctx) => {
        ctx.events.push("text", "line one");
        await Bun.sleep(300);
        return { ok: true, summary: "done" };
      },
    });
    await waitFor(() => store.list().length === 1, "the run");
    await Bun.sleep(20);

    app.failWith = 503;
    await link.flush();
    expect(app.calls.filter((c) => c.route === "update")).toHaveLength(1); // attempted, refused

    app.failWith = 0;
    await link.flush();
    const delivered = app.calls.filter((c) => c.route === "update");
    expect(delivered).toHaveLength(2);
    expect((delivered[1]!.body as RunReport).events!.map((e) => e.text)).toEqual(["line one"]);

    await store.shutdown();
    await running;
  });

  test("EVENTS_PER_REPORT_MAX still bounds one flush", async () => {
    const { link, store, app } = setup();
    await link.beat();
    app.runs.set("r-bound", { dispatchId: "d-bound", taskType: "implement", status: "running", events: [] });
    const running = store.start({
      dispatchId: "d-bound",
      runId: "r-bound",
      name: "r-bound",
      execute: async (ctx) => {
        for (let i = 0; i < EVENTS_PER_REPORT_MAX + 5; i++) ctx.events.push("text", `line ${i}`);
        await Bun.sleep(300);
        return { ok: true, summary: "done" };
      },
    });
    await waitFor(() => store.list().length === 1, "the run");
    await Bun.sleep(20);

    await link.flush();
    const body = app.calls.filter((c) => c.route === "update").at(-1)!.body as RunReport;
    expect(body.events).toHaveLength(EVENTS_PER_REPORT_MAX);
    expect(body.events![0]!.kind).toBe("error"); // the overflow notice leads

    await store.shutdown();
    await running;
  });

  test("a 401 during a flush halts every timer, not just the beat", async () => {
    app = fakeApp({ token: "kai_the_right_token" });
    const h = (active = harness({ appUrl: app.url, token: "kai_the_wrong_token" }));
    const store = new RunStore(h.config);
    const logs: string[] = [];
    const l = (link = startLink(store, h.config, {
      client: appClient({ appUrl: app.url, token: "kai_the_wrong_token" }),
      autostart: false,
      log: (line) => logs.push(line),
    }));

    const running = store.start({
      dispatchId: "d-401",
      runId: "r-401",
      name: "r-401",
      execute: async (ctx) => {
        ctx.events.push("text", "hello");
        await Bun.sleep(300);
        return { ok: true, summary: "done" };
      },
    });
    await waitFor(() => store.list().length === 1, "the run");
    await Bun.sleep(20);

    await l.flush();
    expect(l.status().stopped).toBe("token-rejected");
    // The fake app refuses before it even logs the call — same as any 401.
    expect(app.calls.filter((c) => c.route === "update")).toHaveLength(0);

    await l.flush();
    expect(app.calls.filter((c) => c.route === "update")).toHaveLength(0); // stopped: no retry

    await store.shutdown();
    await running;
  });
});

describe("RF-013 — a restart is reported, never replayed", () => {
  test("a run left running by a dead daemon is reported failed on the first beat", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    writeRunState(h.config.runsDir, {
      dispatchId: "d-old",
      runId: "run-old",
      state: "running",
      pid: 999_999,
      startedAt: new Date().toISOString(),
      branch: "run/d-old",
      worktree: "/tmp/whatever",
    });

    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    const beat = app.calls.find((c) => c.route === "heartbeat")!.body as { runs?: RunReport[] };
    expect(beat.runs).toEqual([
      {
        dispatchId: "d-old",
        runId: "run-old",
        status: "failed",
        summary: "daemon restarted",
        artifacts: { branch: "run/d-old" },
      },
    ]);
    expect(readRunStates(h.config.runsDir)[0]!.state).toBe("failed");
    // Nothing was relaunched: no worktree was cut.
    expect(h.worktrees.created).toHaveLength(0);
  });

  test("a terminal report left undelivered is picked up again on the next boot", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    app.queue({ id: "d-retry", taskType: "research", items: [fakeItem(1)] });
    await fetch(`${app.url}/api/daemon/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.token}` },
    });
    writeRunState(h.config.runsDir, {
      dispatchId: "d-retry",
      runId: "run-1",
      state: "done",
      startedAt: new Date().toISOString(),
      branch: "run/d-retry",
      report: { dispatchId: "d-retry", runId: "run-1", status: "done", summary: "filed the draft" },
    });

    const logs: string[] = [];
    await linkTo(h, app!, logs).beat();

    expect(app.runs.get("run-1")).toMatchObject({ status: "done", summary: "filed the draft" });
    // Accepted, so it is off the disk and will not be sent a third time.
    expect(pendingReports(h.config.runsDir)).toEqual([]);
    expect(JSON.parse(readFileSync(runStatePath(h.config.runsDir, "d-retry", "run-1"), "utf8")).report).toBeUndefined();
  });

  test("a stranded run whose report is already queued is not reported twice", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    writeRunState(h.config.runsDir, {
      dispatchId: "d-both",
      runId: "run-1",
      state: "running",
      pid: 999_999,
      startedAt: new Date().toISOString(),
      branch: "run/d-both",
      report: { dispatchId: "d-both", runId: "run-1", status: "failed", summary: "the real reason" },
    });
    const logs: string[] = [];
    await linkTo(h, app!, logs).beat();

    const beat = app.calls.find((c) => c.route === "heartbeat")!.body as { runs?: RunReport[] };
    expect(beat.runs).toHaveLength(1);
    expect(beat.runs![0]!.summary).toBe("the real reason");
  });
});

describe("§20.9 — the checkout guard, wired the way production wires it", () => {
  test("a claim for another repo is reported failed and nothing is cut", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    await checkoutOf(h.config.repoPath, "owds-inc/kairoku");
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    app.queue({
      id: "d-other",
      taskType: "implement",
      items: [fakeItem(1)],
      repo: { provider: "github", fullName: "someone/else", defaultBranch: "main" },
    });
    expect(await l.poll()).toBe(true);
    await waitFor(() => app!.runs.get("run-1")?.status === "failed", "the refusal to be reported");

    expect(app!.runs.get("run-1")!.summary).toBe("no checkout for someone/else");
    expect(h.worktrees.created).toHaveLength(0);
  });

  test("the same repo in another case is the same repo, and it runs", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    await checkoutOf(h.config.repoPath, "OWDS-Inc/Kairoku");
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    app.queue({
      id: "d-case",
      taskType: "research",
      items: [fakeItem(1)],
      repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
      team: { recipe: "research" },
    });
    expect(await l.poll()).toBe(true);
    await waitFor(() => app!.runs.get("run-1")?.status === "running", "the run to start");
    expect(h.worktrees.created.length).toBeGreaterThan(0);
  });

  test("an unreadable origin fails CLOSED: every claim that names a repo is refused", async () => {
    app = fakeApp();
    const h = (active = harness({ appUrl: app.url, token: app.token }));
    mkdirSync(h.config.repoPath, { recursive: true });
    const logs: string[] = [];
    const l = linkTo(h, app!, logs);
    await l.beat();

    app.queue({
      id: "d-blind",
      taskType: "implement",
      items: [fakeItem(1)],
      repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
    });
    expect(await l.poll()).toBe(true);
    await waitFor(() => app!.runs.get("run-1")?.status === "failed", "the refusal");
    expect(app!.runs.get("run-1")!.summary).toBe("no checkout for owds-inc/kairoku");
  });
});
