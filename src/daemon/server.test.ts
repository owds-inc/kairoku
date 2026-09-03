/**
 * The loopback listener after the push API is retired (SPEC v1, §20.3).
 *
 * There is nothing left to authenticate: runs start in the app, and the only
 * thing this surface does is answer `doctor`. Reachability on 127.0.0.1 is the
 * trust boundary — which is exactly why the wildcard refusal has to stay.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createDaemon, type Daemon } from "./server";
import { harness, stubExec, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
let daemon: Daemon | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  active?.cleanup();
  active = undefined;
});

function start(overrides = {}, deps = {}): { h: Harness; d: Daemon } {
  const h = (active = harness(overrides));
  const d = (daemon = createDaemon(h.config, deps));
  return { h, d };
}

/** One member, one sleeping stub agent — enough to occupy a slot. */
const member = (id: string, role?: "implementer") => ({
  dispatchId: id,
  runId: id,
  name: id,
  ...(role === undefined ? {} : { role }),
  execute: stubExec(["sh", "-c", "sleep 30"]),
});

const get = (d: Daemon, path: string, init: RequestInit = {}) => fetch(`${d.url}${path}`, init);

describe("listener — the bind (RF-006)", () => {
  test("the daemon refuses to bind a wildcard host", () => {
    const h = (active = harness());
    expect(() => createDaemon({ ...h.config, listen: { host: "0.0.0.0", port: 0 } })).toThrow(/RF-006/);
  });

  test("the two read routes need no bearer — there is no inbound credential any more", async () => {
    const { d } = start();
    for (const path of ["/capacity", "/status"]) {
      expect((await get(d, path)).status).toBe(200);
    }
    // A stray authorization header from an old caller is simply ignored.
    expect((await get(d, "/capacity", { headers: { authorization: "Bearer whatever" } })).status).toBe(200);
  });
});

describe("listener — the retired push API (§20.3)", () => {
  test("POST /runs, GET /runs/:id and the cancel route are gone, not merely refused", async () => {
    const { d } = start();
    const gone: Array<[string, RequestInit]> = [
      ["/runs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
      ["/runs/anything", {}],
      ["/runs/anything/cancel", { method: "POST" }],
    ];
    for (const [path, init] of gone) {
      const res = await get(d, path, init);
      expect(`${path}: ${res.status}`).toBe(`${path}: 404`);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("listener — /capacity and /status (RF-005, RF-011)", () => {
  test("GET /capacity tracks running against max", async () => {
    const { h, d } = start({ maxConcurrent: 2 });
    expect(await (await get(d, "/capacity")).json()).toEqual({ running: 0, max: 2 });

    void d.store.start(member("d-cap"));
    expect(await (await get(d, "/capacity")).json()).toEqual({ running: 1, max: 2 });
    await waitFor(() => h.worktrees.created.length === 1, "worktree setup");
  });

  test("GET /status is what `doctor` reads: version, capacity, the app link, runs in flight", async () => {
    const { h, d } = start({ maxConcurrent: 2 }, { link: { status: () => ({ linked: true, appUrl: "https://app.test", liveness: "online" }) } });

    void d.store.start(member("d-status", "implementer"));
    await waitFor(() => h.worktrees.created.length === 1, "worktree setup");

    const body = (await (await get(d, "/status")).json()) as Record<string, any>;
    expect(typeof body.version).toBe("string");
    expect(body.capacity).toEqual({ running: 1, max: 2 });
    expect(body.link).toEqual({ linked: true, appUrl: "https://app.test", liveness: "online" });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      dispatchId: "d-status",
      runId: "d-status",
      role: "implementer",
      status: "running",
      branch: "run/d-status",
    });
  });

  test("an unlinked daemon says so rather than omitting the field", async () => {
    const { d } = start();
    const body = (await (await get(d, "/status")).json()) as { link: { linked: boolean } };
    expect(body.link.linked).toBe(false);
  });

  test("unknown paths 404", async () => {
    const { d } = start();
    expect((await get(d, "/")).status).toBe(404);
    expect((await get(d, "/steer")).status).toBe(404);
  });
});

describe("listener — shutdown", () => {
  test("stop() drains running agents rather than abandoning them", async () => {
    const { h, d } = start();
    const finished = d.store.start(member("d-drain"));
    await waitFor(() => h.worktrees.created.length === 1, "worktree setup");

    await d.stop();
    daemon = undefined;

    // The agent is killed, its worktree torn down, its run reported — not left
    // running with nobody watching.
    expect(h.worktrees.removed).toHaveLength(1);
    expect(await finished).toMatchObject({ status: "error", exitSummary: "daemon-shutdown", branch: "run/d-drain" });
    expect(d.store.capacity().running).toBe(0);
  });
});

describe("waitFor accepts async predicates", () => {
  test("waitFor resolves on a promise-returning predicate", async () => {
    let flipped = false;
    setTimeout(() => (flipped = true), 20);
    await waitFor(async () => flipped, "the flag to flip");
    expect(flipped).toBe(true);
  });
});
