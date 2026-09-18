/**
 * `kairoku mcp-bridge` — stdio JSON-RPC ↔ Streamable HTTP bridge to the
 * Kairoku app's `/api/mcp`, for coding agents that only speak stdio. Wired in
 * by `kairoku mcp setup`; not meant to be typed by hand.
 *
 * stdout carries ONLY JSON-RPC response lines — a coding agent's stdio
 * transport treats anything else on stdout as a malformed frame. Every
 * diagnostic goes to stderr. The token is read from token.env at start and
 * never appears in argv, a child's env, logs or stdout.
 */

import { join } from "node:path";
import { kairokuHome, parseEnvFile } from "../daemon/config";
import { mcpCall } from "./mcp-http";
import { readMcpLogin } from "./login";
import type { Io } from "./io";

export const usage = `usage: kairoku mcp-bridge

  Bridges this coding agent's stdio MCP transport to the Kairoku app's
  Streamable HTTP MCP endpoint, using the token from \`kairoku login\`. Run by
  an agent's own MCP client, not typed by hand. Refuses to serve when logged
  out, or when the app's published resource metadata does not match what
  \`kairoku login\` recorded.`;

const RPC_ERROR = -32000;

function errorFrame(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: RPC_ERROR, message } });
}

export async function run(_args: string[], io: Io): Promise<number> {
  const home = kairokuHome(io.home);
  const mcp = readMcpLogin(io);
  const token = parseEnvFile(io.readFile(join(home, "token.env")) ?? "").KAIROKU_MCP_TOKEN;

  if (!mcp || !token) {
    io.err("mcp-bridge: not logged in — run `kairoku login` first");
    return 1;
  }

  const metadataUrl = new URL("/.well-known/oauth-protected-resource/api/mcp", mcp.appUrl).toString();
  let metadataResource: string;
  try {
    const res = await io.fetch(metadataUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { resource?: unknown };
    if (typeof body.resource !== "string" || !body.resource) throw new Error("no resource field");
    metadataResource = body.resource;
  } catch (e) {
    io.err(`mcp-bridge: could not fetch ${metadataUrl} — ${(e as Error).message}`);
    return 1;
  }
  if (metadataResource !== mcp.resource) {
    io.err(
      `mcp-bridge: refusing — the app's resource metadata (${metadataResource}) no longer matches what \`kairoku login\` recorded (${mcp.resource}). Run \`kairoku login --replace\`.`,
    );
    return 1;
  }

  const url = new URL("/api/mcp", mcp.appUrl).toString();
  let sessionId: string | undefined;
  let sawUnauthorized = false;

  for await (const rawLine of io.stdinLines()) {
    const line = rawLine.trim();
    if (!line) continue;
    let message: { id?: unknown };
    try {
      message = JSON.parse(line) as { id?: unknown };
    } catch {
      io.out(errorFrame(null, "invalid JSON-RPC frame"));
      continue;
    }
    try {
      const result = await mcpCall(io, url, token, message, sessionId);
      if (result.sessionId) sessionId = result.sessionId;
      if (result.status === 401) {
        sawUnauthorized = true;
        io.out(errorFrame(message.id, "unauthorized (401) — the token was rejected; run `kairoku login --replace`"));
        break;
      }
      if (result.status < 200 || result.status >= 300) {
        io.out(errorFrame(message.id, `HTTP ${result.status} from the Kairoku app`));
        continue;
      }
      // A notification (no `id`) gets no reply on the wire either way.
      if (result.json !== undefined) io.out(JSON.stringify(result.json));
    } catch (e) {
      io.out(errorFrame(message.id, `bridge request failed: ${(e as Error).message}`));
    }
  }

  return sawUnauthorized ? 1 : 0;
}
