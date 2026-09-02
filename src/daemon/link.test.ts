/**
 * RF-012 — the loop, against the fake app.
 *
 * The two timers are split from their policy on purpose: `beat()` and `poll()`
 * are each one turn of the loop and each returns what the scheduler needs, so
 * every rule below is asserted without waiting out a real 30-second cadence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appClient } from "./app";
import { ensureRunDir } from "./events";
import { startLink, BACKOFF_START_MS, BACKOFF_MAX_MS, type Link } from "./link";
import { readRunStates, writeRunState } from "./dispatch";
import { RunStore } from "./runs";
import { fakeApp, harness, waitFor, type FakeApp, type Harness } from "./testkit";

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
  link = startLink(store, h.config, {
    client: appClient({ appUrl: app.url, token: h.config.token! }),
    autostart: false,
  });
  return { h, store, link: link!, app: app! };
}

const claims = (a: FakeApp) => a.calls.filter((c) => c.route === "claim").length;
const beats = (a: FakeApp) => a.calls.filter((c) => c.route === "heartbeat").length;

describe("the heartbeat", () => {
  test("carries host, version and capacity, and the app's cadence is what we wait", async () => {
    const { link, app, h } = setup({ maxConcurrent: 3 }, { heartbeatIntervalMs: 7_000, protocol: "1" });

    expect(await link.beat()).toBe(7_000);
    const body = app.calls[0]!.body as { meta: { host: string; version: string; capacity: unknown } };
    expect(typeof body.meta.host).toBe("string");
    expect(body.meta.host.length).toBeGreaterThan(0);
    expect(body.meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.meta.capacity).toEqual({ running: 0, max: 3 });

    expect(link.status()).toMatchObject({ linked: true, appUrl: app.url, liveness: "online", protocol: "1" });
    expect(h.config.appUrl).toBe(app.url);
  });

  test("an unlinked daemon does not dial out at all", async () => {
    const a = (app = fakeApp());
    const h = (active = harness({ appUrl: a.url }));
    const solo = (link = startLink(new RunStore({ ...h.config, token: undefined }), { ...h.config, token: undefined }, { autostart: false }));
    expect(await solo.beat()).toBeGreaterThan(0);
    expect(await solo.poll()).toBe(false);
    expect(a.calls).toHaveLength(0);
    expect(solo.status().linked).toBe(false);
  });
});

describe("backoff (RF-012)", () => {
  test("5xx backs off 30 s doubling to a 5 min cap, and a success resets it", async () => {
    const { link, app } = setup({}, { heartbeatIntervalMs: 9_000 });
    app.failWith = 503;

    const waits: number[] = [];
    for (let i = 0; i < 6; i++) waits.push(await link.beat());
    expect(waits).toEqual([
      BACKOFF_START_MS,
      BACKOFF_START_MS * 2,
      BACKOFF_START_MS * 4,
      BACKOFF_START_MS * 8,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
    ]);
    expect(BACKOFF_START_MS).toBe(30_000);
    expect(BACKOFF_MAX_MS).toBe(300_000);

    app.failWith = 0;
    expect(await link.beat()).toBe(9_000);
    // And the next failure starts from the bottom again, not from the cap.
    app.failWith = 500;
    expect(await link.beat()).toBe(BACKOFF_START_MS);
  });

  test("an unreachable app backs off the same way rather than throwing", async () => {
    const h = (active = harness({ appUrl: "http://127.0.0.1:1", token: "t" }));
    const solo = (link = startLink(new RunStore(h.config), h.config, { autostart: false }));
    expect(await solo.beat()).toBe(BACKOFF_START_MS);
    expect(solo.status().lastError).toContain("did not answer");
  });

  test("it never claims while a heartbeat is failing", async () => {
    const { link, app } = setup();
    app.queue({ id: "d-1", taskType: "research", brief: "look" });
    app.failWith = 503;
    await link.beat();

    expect(await link.poll()).toBe(false);
    expect(claims(app)).toBe(0);
  });
});

describe("401 stops the loop and nothing else (RF-012)", () => {
  test("both timers stop, the message is exact, and the token is not in it", async () => {
    const { app } = setup();
    const rejected = (link = startLink(new RunStore(active!.config), active!.config, {
      client: appClient({ appUrl: app.url, token: "kai_a_stale_token" }),
      autostart: false,
    }));
    app.queue({ id: "d-1", taskType: "research", brief: "look" });

    await rejected.beat();
    expect(rejected.status().stopped).toBe("token-rejected");
    expect(rejected.status().lastError).toBe(`token not accepted by ${app.url}`);
    expect(rejected.status().lastError).not.toContain("kai_a_stale_token");

    // Stopped means stopped: no more beats, no claims, and the listener that
    // `doctor` talks to is untouched — that is the point of not exiting.
    const after = app.calls.length;
    expect(await rejected.beat()).toBe(0);
    expect(await rejected.poll()).toBe(false);
    expect(app.calls).toHaveLength(after);
  });
});

describe("claiming", () => {
  test("a full daemon does not claim; a freed slot does", async () => {
    const { link, app, store, h } = setup({ maxConcurrent: 1, commandOverride: () => ["sh", "-c", "sleep 30"] });
    await link.beat();

    void store.start({ id: "busy", brief: "b", env: { KAIROKU_PAT: "p" } });
    app.queue({ id: "d-1", taskType: "research", brief: "look" });
    expect(await link.poll()).toBe(false);
    expect(claims(app)).toBe(0);

    await waitFor(() => h.worktrees.created.length === 1, "the busy run to be cut");
    await store.shutdown();
    expect(await link.poll()).toBe(true);
    expect(claims(app)).toBe(1);
  });

  test("an empty queue is a poll that took nothing, not a failure", async () => {
    const { link, app } = setup();
    await link.beat();
    expect(await link.poll()).toBe(false);
    expect(claims(app)).toBe(1);
    expect(link.status().stopped).toBeUndefined();
  });

  test("the same dispatch id handed out twice is run once", async () => {
    // The app's claim lease can re-issue a row whose `update running` has not
    // landed yet. Running it a second time is the failure §20 warns about.
    const { link, app, h } = setup({ maxConcurrent: 2, commandOverride: () => ["sh", "-c", "sleep 30"] });
    const twice = { id: "d-dup", taskType: "research" as const, brief: "look" };
    app.queue(twice);
    app.queue(twice);
    await link.beat();

    expect(await link.poll()).toBe(true);
    expect(await link.poll()).toBe(false);
    await waitFor(() => h.worktrees.created.length >= 1, "the first run to be cut");
    expect(h.worktrees.created).toHaveLength(1);
  });
});

describe("the report the app gets", () => {
  test("running at launch, then done with branch, counts and the jsonl path", async () => {
    const { link, app, h } = setup({
      commandOverride: () => [
        "sh",
        "-c",
        "echo '{\"kairoku\": {\"counts\": {\"pass\": 4955, \"fail\": 0, \"skip\": 2, \"errors\": 0}}}'",
      ],
    });
    app.queue({ id: "d-run", taskType: "implement", brief: "Build the thing." });

    await link.beat();
    expect(await link.poll()).toBe(true);

    await waitFor(() => app.rows.get("d-run")?.status === "done", "the run to be reported done");
    const row = app.rows.get("d-run")!;
    expect(row.counts).toEqual({ pass: 4955, fail: 0, skip: 2, errors: 0 });
    expect(row.artifacts).toMatchObject({ branch: "run/d-run" });
    expect((row.artifacts as { jsonl: string }).jsonl).toContain(h.config.runsDir);
    // `running` was reported before `done`, on its own call.
    const updates = app.calls.filter((c) => c.route === "update").map((c) => (c.body as { status: string }).status);
    expect(updates).toEqual(["running", "done"]);
  });

  test("a report the app could not take yet rides the next heartbeat instead of being lost", async () => {
    // Long enough that the app can go unwell between the claim and the report.
    const { link, app } = setup({ commandOverride: () => ["sh", "-c", "sleep 0.2"] });
    app.queue({ id: "d-retry", taskType: "research", brief: "look" });
    await link.beat();
    await link.poll();

    // The app goes unwell exactly while the run is reporting.
    app.failWith = 503;
    await waitFor(() => app.calls.some((c) => c.route === "update"), "the first update attempt");
    await waitFor(() => link.status().pendingReports > 0, "the report to be queued for the beat");

    app.failWith = 0;
    await link.beat();
    await waitFor(
      () => app.rows.get("d-retry")?.status === "done" && link.status().pendingReports === 0,
      "the queued reports to be delivered by the beat",
    );
  });

  test("a 422 is the run's fault, not the link's: it is logged and marked failed locally", async () => {
    // An implement run that cites no suite. The app refuses it (invariant 7),
    // the daemon does not retry it, and run.json says failed with the reason.
    const { link, app, h } = setup({ commandOverride: () => ["sh", "-c", "true"] });
    app.queue({ id: "d-422", taskType: "implement", brief: "Build the thing." });
    await link.beat();
    await link.poll();

    await waitFor(
      () => app.calls.filter((c) => c.route === "update" && (c.body as any).status === "done").length === 1,
      "the refused report",
    );
    await waitFor(() => link.status().pendingReports === 0, "the report to be dropped, not retried");
    expect(app.rows.get("d-422")?.status).toBe("running");
    expect(link.status().lastError).toContain("pass/fail/skip/errors");
    expect(readRunStates(h.config.runsDir).find((r) => r.dispatchId === "d-422")?.state).toBe("failed");
  });
});

describe("RF-013 — a restart is reported, never replayed", () => {
  test("a run left running by a dead daemon is reported failed on the first beat", async () => {
    const { link, app, h } = setup();
    app.queue({ id: "d-stranded", taskType: "research", brief: "look" });
    await link.beat();
    await link.poll();
    // Simulate the daemon dying mid-run: run.json says running, pid is gone.
    ensureRunDir(h.config.runsDir, "d-stranded");
    writeRunState(h.config.runsDir, {
      dispatchId: "d-stranded",
      state: "running",
      pid: 999_999,
      startedAt: "t",
      branch: "run/d-stranded",
    });

    const restarted = startLink(new RunStore(h.config), h.config, {
      client: appClient({ appUrl: app.url, token: h.config.token! }),
      autostart: false,
    });
    await restarted.beat();
    restarted.stop();

    expect(app.rows.get("d-stranded")?.status).toBe("failed");
    expect(app.rows.get("d-stranded")?.summary).toBe("daemon restarted");
  });
});
