/**
 * `kairoku login` / `kairoku logout` — the human MCP sign-in, distinct from
 * the daemon's own link. A real loopback POST (like link-callback.test.ts)
 * plus a fake app server (metadata + Streamable HTTP /api/mcp) proves the
 * whole verify-before-write flow without touching a real Kairoku app.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { logoutRun, run } from "./login";
import { io as realIo } from "./io";
import { fakeIo, type FakeIo } from "./testkit";

const RESOURCE = "https://dev.kairoku.io/api/mcp";
const OWNER = "org_test123";
const TOKEN = "kai_minted_mcp_token";

type Mode = "happy" | "unauthorized" | "resourceMismatch";

/** `event: message\ndata: <json>\n\n` per frame — the real app server's actual framing (mcp-handler legacy-stateless). */
function sseBody(frames: unknown[]): string {
  return ": keepalive\n\n" + frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join("");
}

function fakeApp(opts: { mode?: Mode; metadataResource?: string } = {}) {
  const { mode = "happy", metadataResource } = opts;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
        return Response.json({ resource: metadataResource ?? (mode === "resourceMismatch" ? "https://wrong.example/api/mcp" : RESOURCE) });
      }
      if (req.method === "POST" && url.pathname === "/api/mcp") {
        if (mode === "unauthorized") return new Response(null, { status: 401 });
        const body = (await req.json()) as { id: number; method: string };
        const frame =
          body.method === "tools/list"
            ? { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } }
            : { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } };
        return new Response(sseBody([frame]), { headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" } });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { appUrl: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop() };
}

function testIo(overrides: Partial<FakeIo> = {}): FakeIo {
  return fakeIo({ home: "/home/tester", fetch: realIo.fetch, ...overrides });
}

let servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

describe("kairoku login — verify before write", () => {
  test("happy path: records token.env (0600) + config.json mcp, prints tool count and workspace", async () => {
    const app = fakeApp({ mode: "happy" });
    servers.push(app);
    const io = testIo();

    const codePromise = run(["--app-url", app.appUrl], io);
    const waiting = io.lines.find((l) => l.includes("waiting for"));
    expect(waiting).toBeDefined();
    const linkUrl = new URL(waiting!.split("waiting for ")[1]!);
    expect(linkUrl.searchParams.get("purpose")).toBe("mcp");
    expect(linkUrl.searchParams.get("name")).toMatch(/^cli:/);
    const nonce = linkUrl.searchParams.get("nonce")!;
    const callback = linkUrl.searchParams.get("callback")!;

    const post = await fetch(callback, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: RESOURCE }),
    });
    expect(post.status).toBe(204);

    const code = await codePromise;
    expect(code).toBe(0);
    expect(io.files["/home/tester/.kairoku/token.env"]).toContain(`KAIROKU_MCP_TOKEN=${TOKEN}`);
    expect(io.modes["/home/tester/.kairoku/token.env"]).toBe(0o600);
    const config = JSON.parse(io.files["/home/tester/.kairoku/config.json"]!);
    expect(config.mcp).toEqual({ appUrl: app.appUrl, ownerId: OWNER, resource: RESOURCE });
    expect(io.lines.join("\n")).toContain("3 tool(s)");
    expect(io.lines.join("\n")).toContain(OWNER);
    // Never printed.
    expect(io.lines.join("\n")).not.toContain(TOKEN);
    expect(io.errors.join("\n")).not.toContain(TOKEN);
  });

  test("metadata resource mismatch: nothing persisted, nonzero exit", async () => {
    const app = fakeApp({ mode: "resourceMismatch" });
    servers.push(app);
    const io = testIo();

    const codePromise = run(["--app-url", app.appUrl], io);
    const linkUrl = new URL(io.lines.find((l) => l.includes("waiting for"))!.split("waiting for ")[1]!);
    const nonce = linkUrl.searchParams.get("nonce")!;
    await fetch(linkUrl.searchParams.get("callback")!, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: RESOURCE }),
    });

    const code = await codePromise;
    expect(code).toBe(1);
    expect(io.files["/home/tester/.kairoku/token.env"]).toBeUndefined();
    expect(io.files["/home/tester/.kairoku/config.json"]).toBeUndefined();
    expect(io.errors.join("\n")).toContain("resource metadata mismatch");
  });

  test("401 on the round trip: nothing persisted, nonzero exit", async () => {
    const app = fakeApp({ mode: "unauthorized" });
    servers.push(app);
    const io = testIo();

    const codePromise = run(["--app-url", app.appUrl], io);
    const linkUrl = new URL(io.lines.find((l) => l.includes("waiting for"))!.split("waiting for ")[1]!);
    const nonce = linkUrl.searchParams.get("nonce")!;
    await fetch(linkUrl.searchParams.get("callback")!, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: RESOURCE }),
    });

    const code = await codePromise;
    expect(code).toBe(1);
    expect(io.files["/home/tester/.kairoku/token.env"]).toBeUndefined();
  });

  test("--resource pins what metadata must equal: matching metadata persists it in place of the minted value", async () => {
    // The captured (POST body) resource is the loopback/proxy value; --resource
    // is the canonical one the operator asserts the app's own metadata will
    // confirm. When the app's metadata equals --resource, login persists
    // --resource, not whatever the POST body carried.
    const pinned = "https://dev.kairoku.io/api/mcp";
    const app = fakeApp({ metadataResource: pinned });
    servers.push(app);
    const io = testIo();

    const codePromise = run(["--app-url", app.appUrl, "--resource", pinned], io);
    const linkUrl = new URL(io.lines.find((l) => l.includes("waiting for"))!.split("waiting for ")[1]!);
    const nonce = linkUrl.searchParams.get("nonce")!;
    await fetch(linkUrl.searchParams.get("callback")!, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: "http://127.0.0.1:9999/api/mcp" }),
    });

    const code = await codePromise;
    expect(code).toBe(0);
    const config = JSON.parse(io.files["/home/tester/.kairoku/config.json"]!);
    expect(config.mcp.resource).toBe(pinned);
  });

  test("--resource that the app's metadata does not confirm: nothing persisted, nonzero exit", async () => {
    const app = fakeApp({ metadataResource: "https://dev.kairoku.io/api/mcp" });
    servers.push(app);
    const io = testIo();

    const codePromise = run(["--app-url", app.appUrl, "--resource", "https://not-what-metadata-says.example/api/mcp"], io);
    const linkUrl = new URL(io.lines.find((l) => l.includes("waiting for"))!.split("waiting for ")[1]!);
    const nonce = linkUrl.searchParams.get("nonce")!;
    await fetch(linkUrl.searchParams.get("callback")!, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: "https://dev.kairoku.io/api/mcp" }),
    });

    const code = await codePromise;
    expect(code).toBe(1);
    expect(io.files["/home/tester/.kairoku/token.env"]).toBeUndefined();
    expect(io.files["/home/tester/.kairoku/config.json"]).toBeUndefined();
    expect(io.errors.join("\n")).toContain("resource metadata mismatch");
  });

  test("already signed in refuses without --replace", async () => {
    const io = testIo({
      files: {
        "/home/tester/.kairoku/config.json": JSON.stringify({ mcp: { appUrl: "https://old.example", ownerId: "org_old", resource: "https://old.example/api/mcp" } }),
      },
    });
    const code = await run([], io);
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("already signed in");
  });
});

describe("§3B fix round 1 #3 — no fetch hangs forever", () => {
  test("a metadata endpoint that never answers fails login instead of hanging", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // never resolves
    });
    servers.push({ stop: () => server.stop(true) });
    const appUrl = `http://127.0.0.1:${server.port}`;
    const io = testIo();

    const codePromise = run(["--app-url", appUrl], io);
    const linkUrl = new URL(io.lines.find((l) => l.includes("waiting for"))!.split("waiting for ")[1]!);
    const nonce = linkUrl.searchParams.get("nonce")!;
    await fetch(linkUrl.searchParams.get("callback")!, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ token: TOKEN, nonce, ownerId: OWNER, resource: RESOURCE }),
    });

    const code = await codePromise;
    expect(code).toBe(1);
    expect(io.files["/home/tester/.kairoku/token.env"]).toBeUndefined();
  }, 20_000);
});

describe("kairoku logout", () => {
  test("removes KAIROKU_MCP_TOKEN and config.mcp, keeps other token.env lines, prints the revoke URL", async () => {
    const io = testIo({
      files: {
        "/home/tester/.kairoku/token.env": "KAIROKU_DAEMON_TOKEN=kai_daemon\nKAIROKU_MCP_TOKEN=kai_mcp\n",
        "/home/tester/.kairoku/config.json": JSON.stringify({ appUrl: "https://app.test", mcp: { appUrl: "https://app.test", ownerId: OWNER, resource: RESOURCE } }),
      },
      modes: { "/home/tester/.kairoku/token.env": 0o600 },
    });
    const code = await logoutRun([], io);
    expect(code).toBe(0);
    expect(io.files["/home/tester/.kairoku/token.env"]).toContain("KAIROKU_DAEMON_TOKEN=kai_daemon");
    expect(io.files["/home/tester/.kairoku/token.env"]).not.toContain("KAIROKU_MCP_TOKEN");
    const config = JSON.parse(io.files["/home/tester/.kairoku/config.json"]!);
    expect(config.mcp).toBeUndefined();
    expect(config.appUrl).toBe("https://app.test");
    expect(io.lines.join("\n")).toContain("https://app.test/settings/tokens");
    expect(io.lines.join("\n")).toMatch(/cli:.+/);
  });
});
