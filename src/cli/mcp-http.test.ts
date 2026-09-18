/**
 * `mcpCall` / `fetchResourceMetadata` — the shared Streamable HTTP client.
 * The real Kairoku app (`mcp-handler`'s legacy-stateless mode) answers every
 * POST with `text/event-stream`, one `data:` event per JSON-RPC message,
 * never bare JSON (see task-3B-review.md's transport-framing verdict); this
 * is the production path, so it is the one exercised here against a real
 * `Bun.serve` server, not a fake `Response.json(...)`. The JSON branch stays
 * covered too, since a future or alternate server could take it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { fetchResourceMetadata, mcpCall } from "./mcp-http";
import { io as realIo } from "./io";

let servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

/** `event: message\ndata: <json>\n\n` per frame, plus a `: keepalive` comment line first — exactly mcp-handler's shape. */
function sseBody(frames: unknown[]): string {
  const keepalive = ": keepalive\n\n";
  return keepalive + frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join("");
}

function ioWithFetch(fetch: typeof realIo.fetch) {
  return { ...realIo, fetch };
}

describe("mcpCall — SSE (the real server's actual framing)", () => {
  test("a single-frame SSE response parses to one message, session id carried, keepalive ignored", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(sseBody([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]), {
          headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
        }),
    });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    const result = await mcpCall(io, `http://127.0.0.1:${server.port}/api/mcp`, "tok", { jsonrpc: "2.0", id: 1, method: "x" });
    expect(result.status).toBe(200);
    expect(result.sessionId).toBe("sess-1");
    expect(result.messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  test("a multi-frame SSE response (notification then response) keeps EVERY frame, in order", async () => {
    const notification = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
    const response = { jsonrpc: "2.0", id: 7, result: { done: true } };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(sseBody([notification, response]), { headers: { "content-type": "text/event-stream" } }),
    });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    const result = await mcpCall(io, `http://127.0.0.1:${server.port}/api/mcp`, "tok", { jsonrpc: "2.0", id: 7, method: "y" });
    expect(result.messages).toEqual([notification, response]);
  });

  test("a 202 notification ack (no body) yields zero messages, not an error", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 202 }) });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    const result = await mcpCall(io, `http://127.0.0.1:${server.port}/api/mcp`, "tok", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(result.status).toBe(202);
    expect(result.messages).toEqual([]);
  });
});

describe("mcpCall — bare JSON (kept working; not what the real server sends, but a valid response)", () => {
  test("a single JSON body parses to one message", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    const result = await mcpCall(io, `http://127.0.0.1:${server.port}/api/mcp`, "tok", { jsonrpc: "2.0", id: 1, method: "x" });
    expect(result.messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });
});

describe("timeouts", () => {
  test("mcpCall aborts a request that outlives its timeout", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      },
    });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    await expect(
      mcpCall(io, `http://127.0.0.1:${server.port}/api/mcp`, "tok", { jsonrpc: "2.0", id: 1, method: "x" }, undefined, 50),
    ).rejects.toThrow();
  });

  test("fetchResourceMetadata aborts a request that outlives its timeout", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return Response.json({ resource: "https://x.test/api/mcp" });
      },
    });
    servers.push(server);
    const io = ioWithFetch(realIo.fetch);
    await expect(fetchResourceMetadata(io, `http://127.0.0.1:${server.port}`, 50)).rejects.toThrow();
  });
});
