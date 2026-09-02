/**
 * The app client (RF-011) against the fake app.
 *
 * Every answer the daemon can get is turned into a TAG, not a status code, and
 * that is the point of this suite: the loop's whole policy hangs off the tag,
 * so `link.ts` never reads a number and the three ways a call can fail cannot
 * be confused for one another.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appClient, DAEMON_ROUTES } from "./app";
import { fakeApp, type FakeApp } from "./testkit";

let app: FakeApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function client(overrides: { token?: string; appUrl?: string; timeoutMs?: number } = {}) {
  app ??= fakeApp();
  return appClient({ appUrl: overrides.appUrl ?? app.url, token: overrides.token ?? app.token, ...overrides });
}

const meta = { host: "vm-1", version: "0.1.0", capacity: { running: 0, max: 2 } };

describe("app client — the three routes and nothing else", () => {
  test("the route table is exactly the three the app answers", () => {
    expect([...DAEMON_ROUTES]).toEqual([
      "/api/daemon/heartbeat",
      "/api/daemon/claim",
      "/api/daemon/update",
    ]);
  });

  test("a trailing slash on the configured app URL does not double up", async () => {
    app = fakeApp();
    const result = await appClient({ appUrl: `${app.url}/`, token: app.token }).heartbeat({ meta });
    expect(result.ok).toBe(true);
  });
});

describe("app client — heartbeat", () => {
  test("a heartbeat carries meta and comes back with the cadence to use next", async () => {
    app = fakeApp({ heartbeatIntervalMs: 12_345, protocol: "1" });
    const result = await client().heartbeat({ meta });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.heartbeatIntervalMs).toBe(12_345);
    expect(result.body.liveness).toBe("online");
    expect(result.body.protocol).toBe("1");
    expect(app.calls[0]).toEqual({ route: "heartbeat", body: { meta } });
  });

  test("a heartbeat can piggyback reports, and each one is answered separately", async () => {
    app = fakeApp();
    app.queue({ id: "d1", taskType: "research", brief: "look" });
    const c = client();
    await c.claim();

    const result = await c.heartbeat({
      meta,
      runs: [
        { dispatchId: "d1", status: "done", summary: "filed" },
        { dispatchId: "nope", status: "done" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.runs[0]).toEqual({ ok: true, id: "d1", status: "done" });
    expect(result.body.runs[1]).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("app client — claim", () => {
  test("an empty queue is a success carrying null, never an error", async () => {
    const result = await client().claim();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.dispatch).toBeNull();
  });

  test("a claimed dispatch arrives with its brief and whatever v1 fields the app sends", async () => {
    app = fakeApp();
    app.queue({
      id: "d2",
      taskType: "implement",
      brief: "Build the thing.",
      repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
      items: [{ id: "i1", runToken: "kai_run_token" }],
    });
    const result = await client().claim();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.dispatch).toMatchObject({
      id: "d2",
      taskType: "implement",
      brief: "Build the thing.",
      repo: { fullName: "owds-inc/kairoku", defaultBranch: "main" },
    });
    expect(result.body.dispatch?.items?.[0]?.runToken).toBe("kai_run_token");
  });
});

describe("app client — update", () => {
  test("a report the app accepts comes back ok", async () => {
    app = fakeApp();
    app.queue({ id: "d3", taskType: "implement", brief: "go" });
    const c = client();
    await c.claim();

    expect((await c.update({ dispatchId: "d3", status: "running" })).ok).toBe(true);
    const done = await c.update({
      dispatchId: "d3",
      status: "done",
      summary: "green",
      counts: { pass: 4955, fail: 0, skip: 2, errors: 0 },
      artifacts: { branch: "run/d3", jsonl: "/runs/d3/events.jsonl" },
    });
    expect(done.ok).toBe(true);
    expect(app.rows.get("d3")).toMatchObject({ status: "done", counts: { pass: 4955, fail: 0, skip: 2, errors: 0 } });
  });

  test("invariant 7: implement + done with no counts is `rejected`, and the app writes nothing", async () => {
    app = fakeApp();
    app.queue({ id: "d4", taskType: "implement", brief: "go" });
    const c = client();
    await c.claim();
    await c.update({ dispatchId: "d4", status: "running" });

    const refused = await c.update({ dispatchId: "d4", status: "done", summary: "green" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("rejected");
    expect(refused.status).toBe(422);
    expect(refused.issues?.[0]).toContain("pass/fail/skip/errors");
    expect(app.rows.get("d4")?.status).toBe("running");
  });

  test("a dispatch this daemon does not hold is `rejected`, not a crash", async () => {
    const refused = await client().update({ dispatchId: "made-up", status: "failed" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("rejected");
    expect(refused.status).toBe(404);
  });
});

describe("app client — how a call can fail", () => {
  test("401 is `unauthorized` on every route, and the message never carries the token", async () => {
    app = fakeApp();
    const c = client({ token: "kai_wrong_token_value" });
    for (const result of [await c.heartbeat({ meta }), await c.claim(), await c.update({ dispatchId: "x", status: "failed" })]) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("unauthorized");
      expect(result.status).toBe(401);
      expect(result.error).not.toContain("kai_wrong_token_value");
    }
  });

  test("5xx is `server` — the app is up but unwell, so the caller backs off", async () => {
    app = fakeApp();
    app.failWith = 503;
    const result = await client().heartbeat({ meta });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("server");
    expect(result.status).toBe(503);
  });

  test("an unreachable app is `network` with status 0, not an exception the loop must catch", async () => {
    // Port 1 on loopback: nothing listens, so this is a real connection refusal
    // rather than a mocked one.
    const result = await appClient({ appUrl: "http://127.0.0.1:1", token: "t" }).claim();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("network");
    expect(result.status).toBe(0);
  });
});
