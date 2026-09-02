import { afterEach, describe, expect, test } from "bun:test";
import { createDaemon, tokenMatches, type Daemon } from "./server";
import { harness, runRequest, TEST_TOKEN, waitFor, type Harness } from "./testkit";

let active: Harness | undefined;
let daemon: Daemon | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  active?.cleanup();
  active = undefined;
});

function start(overrides = {}): { h: Harness; d: Daemon } {
  const h = (active = harness({
    commandOverride: () => ["sh", "-c", "sleep 30"],
    ...overrides,
  }));
  const d = (daemon = createDaemon(h.config));
  return { h, d };
}

function call(
  d: Daemon,
  path: string,
  init: RequestInit = {},
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${d.url}${path}`, { ...init, headers });
}

const post = (d: Daemon, path: string, body?: unknown, token?: string | null) =>
  call(
    d,
    path,
    { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    token === undefined ? TEST_TOKEN : token,
  );

describe("server — auth (RF-006)", () => {
  test("tokenMatches is exact and length-independent", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    // Differing lengths must compare, not throw — timingSafeEqual would.
    expect(tokenMatches("a-much-longer-offered-token", "abc")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });

  test("every route is 401 without a valid bearer", async () => {
    const { d } = start();
    const cases: Array<[string, RequestInit]> = [
      ["/capacity", {}],
      ["/runs", { method: "POST", body: "{}" }],
      ["/runs/anything", {}],
      ["/runs/anything/cancel", { method: "POST" }],
    ];
    for (const [path, init] of cases) {
      expect((await call(d, path, init, null)).status).toBe(401);
      expect((await call(d, path, init, "wrong-token")).status).toBe(401);
    }
  });

  test("a non-Bearer authorization header is rejected", async () => {
    const { d } = start();
    const res = await fetch(`${d.url}/capacity`, {
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("the daemon refuses to bind a wildcard host", () => {
    const h = (active = harness());
    expect(() =>
      createDaemon({ ...h.config, listen: { host: "0.0.0.0", port: 0 } }),
    ).toThrow(/RF-006/);
  });
});

describe("server — routes (RF-001..RF-005)", () => {
  test("POST /runs returns 201 and a runId", async () => {
    const { d } = start();
    const res = await post(d, "/runs", runRequest("pat-http"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-f]{12}$/);
  });

  test("each refusal answers 4xx with its named reason", async () => {
    const { d } = start({ maxConcurrent: 2 });
    const expectRefusal = async (
      body: unknown,
      status: number,
      reason: string,
    ) => {
      const res = await post(d, "/runs", body);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ reason });
    };

    await expectRefusal({ ...runRequest("p"), brief: "" }, 400, "empty_brief");
    await expectRefusal(
      { ...runRequest("p"), role: "reviewer" },
      400,
      "unknown_role",
    );
    await expectRefusal({ ...runRequest("p"), env: {} }, 400, "missing_credential");

    expect((await post(d, "/runs", runRequest("holder"))).status).toBe(201);
    await expectRefusal(runRequest("holder"), 409, "duplicate_credential");

    expect((await post(d, "/runs", runRequest("second"))).status).toBe(201);
    await expectRefusal(runRequest("third"), 429, "capacity_full");
  });

  test("when both apply, capacity_full is the reason reported", async () => {
    // Precedence is checked before duplicate distinctness: a full daemon has
    // nothing to offer whatever credential is presented, so the cheaper and
    // more general reason is the honest one.
    const { d } = start({ maxConcurrent: 1 });
    expect((await post(d, "/runs", runRequest("only"))).status).toBe(201);
    const res = await post(d, "/runs", runRequest("only"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "capacity_full" });
  });

  test("a malformed body is refused, not crashed on", async () => {
    const { d } = start();
    const res = await fetch(`${d.url}/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "empty_brief" });
  });

  test("GET /runs/{id} answers RF-002's shape, and 404s an unknown id", async () => {
    const { d } = start();
    const created = (await (await post(d, "/runs", runRequest("pat-view"))).json()) as {
      runId: string;
    };

    const res = await call(d, `/runs/${created.runId}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view.status).toBe("running");
    expect(view.branch).toBe(`run/${created.runId}`);
    expect(typeof view.startedAt).toBe("string");
    // exitSummary is absent while running, not null.
    expect(view).not.toHaveProperty("exitSummary");

    const missing = await call(d, "/runs/deadbeef");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  test("POST /runs/{id}/cancel cancels once, then 404s the settled run", async () => {
    const { d } = start();
    const { runId } = (await (
      await post(d, "/runs", runRequest("pat-cancel"))
    ).json()) as { runId: string };

    const res = await post(d, `/runs/${runId}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });

    await waitFor(async () => {
      const view = (await (await call(d, `/runs/${runId}`)).json()) as {
        status: string;
      };
      return view.status !== "running";
    }, "the cancelled run to settle");

    const again = await post(d, `/runs/${runId}/cancel`);
    expect(again.status).toBe(404);

    const view = (await (await call(d, `/runs/${runId}`)).json()) as {
      status: string;
      exitSummary: string;
    };
    expect(view).toMatchObject({ status: "error", exitSummary: "cancelled" });
  });

  test("GET /capacity tracks running against max", async () => {
    const { d } = start({ maxConcurrent: 2 });
    expect(await (await call(d, "/capacity")).json()).toEqual({
      running: 0,
      max: 2,
    });
    await post(d, "/runs", runRequest("cap-a"));
    expect(await (await call(d, "/capacity")).json()).toEqual({
      running: 1,
      max: 2,
    });
  });

  test("unknown paths 404", async () => {
    const { d } = start();
    expect((await call(d, "/")).status).toBe(404);
    expect((await call(d, "/runs/x/steer")).status).toBe(404);
  });

  test("stop() drains running agents rather than abandoning them", async () => {
    const { h, d } = start();
    const { runId } = (await (
      await post(d, "/runs", runRequest("pat-drain"))
    ).json()) as { runId: string };
    await waitFor(() => h.worktrees.created.length === 1, "worktree setup");

    await d.stop();
    daemon = undefined;

    // The agent is killed, its worktree torn down, its run marked — not left
    // running with nobody watching.
    expect(h.worktrees.removed).toHaveLength(1);
    expect(d.store.view(runId)).toMatchObject({
      status: "error",
      exitSummary: "daemon-shutdown",
    });
    expect(d.store.capacity().running).toBe(0);
  });
});

describe("server — waitFor accepts async predicates", () => {
  test("waitFor resolves on a promise-returning predicate", async () => {
    let flipped = false;
    setTimeout(() => (flipped = true), 20);
    await waitFor(async () => flipped, "the flag to flip");
    expect(flipped).toBe(true);
  });
});
