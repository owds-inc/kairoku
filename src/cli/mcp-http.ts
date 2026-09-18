/**
 * A minimal MCP Streamable HTTP client: one JSON-RPC request in, the
 * response (JSON or a single-event SSE stream) parsed back out, with the
 * `Mcp-Session-Id` response header carried forward by the caller. Shared by
 * `kairoku login` (the one-shot initialize + tools/list proof) and
 * `kairoku mcp-bridge` (every request an agent sends).
 */

import type { Io } from "./io";

export type McpCallResult = { status: number; sessionId?: string; json?: unknown; text: string };

export async function mcpCall(
  io: Io,
  url: string,
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<McpCallResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await io.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const respSessionId = res.headers.get("mcp-session-id") ?? undefined;
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  let json: unknown;
  if (contentType.includes("text/event-stream")) {
    const lines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const last = lines[lines.length - 1];
    if (last) {
      try {
        json = JSON.parse(last);
      } catch {
        // left undefined — the caller treats a missing frame as an error
      }
    }
  } else if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      // non-JSON body (e.g. an HTML error page) — status + text still returned
    }
  }
  return { status: res.status, ...(respSessionId ? { sessionId: respSessionId } : {}), json, text: raw };
}
