/**
 * A minimal MCP Streamable HTTP client: one JSON-RPC request in, EVERY frame
 * of the response (a single JSON body, or every `data:` event of an SSE
 * stream — the real server, `mcp-handler`'s legacy-stateless mode, answers a
 * POST with `text/event-stream` and one `data:` event per JSON-RPC message,
 * never bare JSON; see CLI-MCP-UNIFIED-AUTH-PLAN.md fix-round-1 review) back
 * out, in order, with the `Mcp-Session-Id` response header carried forward by
 * the caller. Shared by `kairoku login` (the one-shot initialize + tools/list
 * proof), `kairoku mcp-bridge` (every request an agent sends) and `kairoku
 * doctor` (the reachability probe).
 */

import type { Io } from "./io";

export type McpCallResult = {
  status: number;
  sessionId?: string;
  /** Every JSON-RPC message the response carried, in the order it arrived — a
   * plain-JSON body is one message; an SSE stream may carry several
   * (a response plus mid-call notifications, or a server→client request). */
  messages: unknown[];
  text: string;
};

/** 15s — a metadata GET or a login's one-shot initialize/tools/list proof. */
export const SHORT_TIMEOUT_MS = 15_000;
/** 120s — a bridge request an agent is waiting on; generous for a long tool call. */
export const BRIDGE_TIMEOUT_MS = 120_000;

export async function mcpCall(
  io: Io,
  url: string,
  token: string,
  body: unknown,
  sessionId?: string,
  timeoutMs: number = SHORT_TIMEOUT_MS,
): Promise<McpCallResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await io.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const respSessionId = res.headers.get("mcp-session-id") ?? undefined;
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    // Every `data:` line is one frame; a bare `: keepalive` comment line (no
    // `data:` prefix) is not one and is correctly skipped by the filter.
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        // a malformed frame is dropped, not fatal — the caller judges an
        // empty `messages` array as "nothing usable came back"
      }
    }
  } else if (raw) {
    try {
      messages.push(JSON.parse(raw));
    } catch {
      // non-JSON body (e.g. an HTML error page) — status + text still returned
    }
  }
  return { status: res.status, ...(respSessionId ? { sessionId: respSessionId } : {}), messages, text: raw };
}

/** `${appUrl}/.well-known/oauth-protected-resource/api/mcp`, with a timeout — shared by login, bridge and doctor. */
export async function fetchResourceMetadata(io: Io, appUrl: string, timeoutMs: number = SHORT_TIMEOUT_MS): Promise<string> {
  const url = new URL("/.well-known/oauth-protected-resource/api/mcp", appUrl).toString();
  const res = await io.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`metadata fetch failed: HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { resource?: unknown };
  if (typeof body.resource !== "string" || !body.resource) throw new Error(`metadata at ${url} has no resource field`);
  return body.resource;
}
