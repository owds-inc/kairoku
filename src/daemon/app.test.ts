/**
 * The app client (RF-011) against the fake app.
 *
 * Every answer the daemon can get is turned into a TAG, not a status code, and
 * that is the point of this suite: the loop's whole policy hangs off the tag,
 * so `link.ts` never reads a number and the three ways a call can fail cannot
 * be confused for one another.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appClient, DAEMON_ROUTES, PROTOCOL_VERSION } from "./app";
import { fakeApp, fakeItem, type FakeApp } from "./testkit";

let app: FakeApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function client(overrides: { token?: string; appUrl?: string; timeoutMs?: number } = {}) {
  app ??= fakeApp();
  return appClient({ appUrl: overrides.appUrl ?? app.url, token: overrides.token ?? app.token, ...overrides });
}

const meta = {
  protocol: PROTOCOL_VERSION,
  host: "vm-1",
  version: "0.1.0",
  capacity: { running: 0, max: 2 },
  repos: ["owds-inc/kairoku"],
  providers: { claude: ["claude-opus-5"] },
  recipes: ["solo", "build-verify"],
};

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
    expect(result.body.cancel).toEqual([]);
    expect(app.calls[0]).toEqual({ route: "heartbeat", body: { meta } });
    // meta travels whole: the composer greys models off this and the claim
    // query filters on `repos`.
    expect(app.metas[0]).toEqual(meta);
  });

  test("a heartbeat can piggyback reports, and each one is answered separately", async () => {
    app = fakeApp();
    app.queue({ id: "d1", taskType: "research", items: [fakeItem(1)] });
    const c = client();
    await c.claim();

    const result = await c.heartbeat({
      meta,
      runs: [
        { dispatchId: "d1", runId: "run-1", status: "done", summary: "filed" },
        { dispatchId: "d1", runId: "run-nope", status: "done" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.runs?.[0]).toEqual({ ok: true, id: "d1", runId: "run-1", status: "done" });
    expect(result.body.runs?.[1]).toEqual({ ok: false, reason: "not-found", runId: "run-nope" });
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
      team: { recipe: "build-verify", roles: { implementer: { provider: "claude", model: "claude-opus-5" } } },
      items: [fakeItem(1)],
      limits: { runSeconds: 900 },
    });
    const result = await client().claim();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.dispatch).toMatchObject({
      id: "d2",
      taskType: "implement",
      brief: "Build the thing.",
      repo: { fullName: "owds-inc/kairoku", defaultBranch: "main" },
      team: { recipe: "build-verify" },
      limits: { runSeconds: 900 },
    });
    expect(result.body.dispatch?.items?.[0]).toMatchObject({ id: "item-1", runId: "run-1", runToken: "kai_run_token_1" });
  });
});

describe("app client — update", () => {
  test("a report the app accepts comes back ok", async () => {
    app = fakeApp();
    app.queue({ id: "d3", taskType: "implement", items: [fakeItem(1)] });
    const c = client();
    await c.claim();

    expect((await c.update({ dispatchId: "d3", runId: "run-1", status: "running" })).ok).toBe(true);
    const done = await c.update({
      dispatchId: "d3",
      runId: "run-1",
      status: "done",
      summary: "green",
      counts: { pass: 4955, fail: 0, skip: 2, errors: 0 },
      artifacts: { branch: "run/d3", prUrl: "https://github.com/owds-inc/kairoku/pull/7" },
    });
    expect(done.ok).toBe(true);
    expect(app.runs.get("run-1")).toMatchObject({
      status: "done",
      counts: { pass: 4955, fail: 0, skip: 2, errors: 0 },
    });
  });

  test("invariant 7: implement + done with no counts is `rejected`, and the app writes nothing", async () => {
    app = fakeApp();
    app.queue({ id: "d4", taskType: "implement", items: [fakeItem(1)] });
    const c = client();
    await c.claim();
    await c.update({ dispatchId: "d4", runId: "run-1", status: "running" });

    const refused = await c.update({ dispatchId: "d4", runId: "run-1", status: "done", summary: "green" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("rejected");
    expect(refused.status).toBe(422);
    expect(refused.issues?.[0]).toContain("pass/fail/skip/errors");
    expect(app.runs.get("run-1")?.status).toBe("running");
  });

  test("a dispatch this daemon does not hold is `rejected`, not a crash", async () => {
    const refused = await client().update({ dispatchId: "made-up", runId: "run-made-up", status: "failed" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("rejected");
    expect(refused.status).toBe(404);
  });

  test("a run that already finished answers 409, which is `rejected` and never retried", async () => {
    app = fakeApp();
    app.queue({ id: "d5", taskType: "research", items: [fakeItem(1)] });
    const c = client();
    await c.claim();
    expect((await c.update({ dispatchId: "d5", runId: "run-1", status: "done" })).ok).toBe(true);

    const again = await c.update({ dispatchId: "d5", runId: "run-1", status: "failed" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.kind).toBe("rejected");
    expect(again.status).toBe(409);
  });
});

describe("app client — how a call can fail", () => {
  test("401 is `unauthorized` on every route, and the message never carries the token", async () => {
    app = fakeApp();
    const c = client({ token: "kai_wrong_token_value" });
    for (const result of [await c.heartbeat({ meta }), await c.claim(), await c.update({ dispatchId: "x", runId: "y", status: "failed" })]) {
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
