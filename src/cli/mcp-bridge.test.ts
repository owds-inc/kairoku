/**
 * `kairoku mcp-bridge` — stdio JSON-RPC ↔ Streamable HTTP, against a fake
 * `Bun.serve` app server. Asserts the three fail-safes from the design doc:
 * resource-metadata mismatch refuses before any forwarded call, a missing
 * token refuses before any network call, and a 401 mid-stream ends the
 * bridge nonzero — plus that stdout carries only JSON-RPC lines.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { run } from "./mcp-bridge";
import { io as realIo } from "./io";
import { fakeIo, type FakeIo } from "./testkit";

const RESOURCE = "https://dev.kairoku.io/api/mcp";
const TOKEN = "kai_bridge_token";

function fakeApp(opts: { unauthorizedOn?: string } = {}) {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
        return Response.json({ resource: RESOURCE });
      }
      if (req.method === "POST" && url.pathname === "/api/mcp") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
        const body = (await req.json()) as { id: number; method: string };
        seen.push(body.method);
        if (opts.unauthorizedOn === body.method) return new Response(null, { status: 401 });
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "mcp-session-id": "sess-9" } });
        }
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "x" }] } });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { appUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop() };
}

function loggedInIo(appUrl: string, resource = RESOURCE, overrides: Partial<FakeIo> = {}): FakeIo {
  return fakeIo({
    home: "/home/tester",
    fetch: realIo.fetch,
    files: {
      "/home/tester/.kairoku/config.json": JSON.stringify({ mcp: { appUrl, ownerId: "org_x", resource } }),
      "/home/tester/.kairoku/token.env": `KAIROKU_MCP_TOKEN=${TOKEN}\n`,
    },
    ...overrides,
  });
}

async function* lines(...ls: string[]): AsyncGenerator<string> {
  for (const l of ls) yield l;
}

let servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

describe("kairoku mcp-bridge", () => {
  test("initialize + tools/list round trip over stdio; stdout carries only JSON-RPC lines", async () => {
    const app = fakeApp();
    servers.push(app);
    const io = loggedInIo(app.appUrl, RESOURCE, {
      stdinLines: () =>
        lines(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        ),
    });

    const code = await run([], io);
    expect(code).toBe(0);
    expect(io.lines.length).toBe(2);
    for (const line of io.lines) expect(() => JSON.parse(line)).not.toThrow();
    const init = JSON.parse(io.lines[0]!);
    const list = JSON.parse(io.lines[1]!);
    expect(init.id).toBe(1);
    expect(list.result.tools).toEqual([{ name: "x" }]);
    expect(app.seen).toEqual(["initialize", "tools/list"]);
    // The token never leaks into a line printed anywhere.
    expect(io.lines.join("\n")).not.toContain(TOKEN);
  });

  test("resource metadata mismatch refuses before any forwarded call", async () => {
    const app = fakeApp();
    servers.push(app);
    const io = loggedInIo(app.appUrl, "https://stale.example/api/mcp", {
      stdinLines: () => lines(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })),
    });

    const code = await run([], io);
    expect(code).toBe(1);
    expect(app.seen).toEqual([]);
    expect(io.errors.join("\n")).toContain("no longer matches");
  });

  test("missing token refuses before any network call", async () => {
    const io = fakeIo({
      home: "/home/tester",
      fetch: () => Promise.reject(new Error("must not be called")),
      files: {
        "/home/tester/.kairoku/config.json": JSON.stringify({ mcp: { appUrl: "https://app.test", ownerId: "o", resource: RESOURCE } }),
      },
    });
    const code = await run([], io);
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain("not logged in");
  });

  test("401 mid-stream: error frame on stdout, nonzero exit", async () => {
    const app = fakeApp({ unauthorizedOn: "tools/list" });
    servers.push(app);
    const io = loggedInIo(app.appUrl, RESOURCE, {
      stdinLines: () =>
        lines(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        ),
    });

    const code = await run([], io);
    expect(code).toBe(1);
    expect(io.lines.length).toBe(2);
    const errorFrame = JSON.parse(io.lines[1]!);
    expect(errorFrame.error).toBeDefined();
    expect(errorFrame.id).toBe(2);
  });
});
