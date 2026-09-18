/**
 * `kairoku login` / `kairoku logout` — human sign-in for MCP access, distinct
 * from the daemon's own `KAIROKU_DAEMON_TOKEN` (setup.ts). One browser hop at
 * `${appUrl}/link?purpose=mcp` mints an owner-scoped personal MCP token
 * (`kai_…`, named `cli:<hostname>`); this CLI stores it and proves it before
 * writing anything durable (design: CLI-MCP-UNIFIED-AUTH-PLAN.md).
 *
 * Verify-before-write: the metadata check and the initialize+tools/list round
 * trip both run BEFORE `token.env`/`config.json` are touched, so a failure
 * never leaves a half-written record to clean up.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { kairokuHome, normaliseAppUrl } from "../daemon/config";
import { listenForLink, openLink, setTokenEnv, type LinkPersistPayload } from "./link-callback";
import { mcpCall } from "./mcp-http";
import { DEFAULT_APP_URL } from "./provision";
import type { Io } from "./io";

export type McpLoginConfig = { appUrl: string; ownerId: string; resource: string };

export const usage = `usage: kairoku login [--app-url <url>] [--resource <url>] [--replace]

  Signs this CLI in to a Kairoku workspace for MCP access (a different
  credential from the daemon's own \`kairoku setup --daemon\` link). Opens a
  browser at <app-url>/link?purpose=mcp; on success writes KAIROKU_MCP_TOKEN
  into ~/.kairoku/token.env (mode 600) and mcp: {appUrl, ownerId, resource}
  into ~/.kairoku/config.json (no secret). Verifies BEFORE writing anything:
  the app's published resource metadata must match, then one MCP initialize +
  tools/list round trip must succeed with the minted token.

  --app-url <url>   the Kairoku app to sign in to [${DEFAULT_APP_URL}]
  --resource <url>  pin the expected protected-resource id, when the
                     transport URL is a protection proxy whose own metadata
                     names a different origin (e.g. a dev tunnel)
  --replace         sign in again even though a login is already recorded`;

export const logoutUsage = `usage: kairoku logout

  Removes the local Kairoku MCP token and mcp config from this machine. This
  does not revoke the token server side — visit Settings → Tokens in the app
  and revoke the row named cli:<hostname>.`;

function configPath(io: Io): string {
  return join(kairokuHome(io.home), "config.json");
}

function readConfig(io: Io): Record<string, unknown> {
  try {
    return JSON.parse(io.readFile(configPath(io)) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readMcpLogin(io: Io): McpLoginConfig | undefined {
  const mcp = readConfig(io).mcp as McpLoginConfig | undefined;
  return mcp && typeof mcp.appUrl === "string" && typeof mcp.ownerId === "string" && typeof mcp.resource === "string"
    ? mcp
    : undefined;
}

function writeMcpLogin(io: Io, mcp: McpLoginConfig | null): void {
  const config = readConfig(io);
  if (mcp) config.mcp = mcp;
  else delete config.mcp;
  io.writeFile(configPath(io), JSON.stringify(config, null, 2) + "\n");
}

async function fetchMetadataResource(io: Io, appUrl: string): Promise<string> {
  const url = new URL("/.well-known/oauth-protected-resource/api/mcp", appUrl).toString();
  const res = await io.fetch(url);
  if (!res.ok) throw new Error(`metadata fetch failed: HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { resource?: unknown };
  if (typeof body.resource !== "string" || !body.resource) throw new Error(`metadata at ${url} has no resource field`);
  return body.resource;
}

/** One initialize + tools/list, over the bearer just minted. Never logs the token. */
async function proveMcpAccess(io: Io, appUrl: string, token: string): Promise<{ toolCount: number }> {
  const url = new URL("/api/mcp", appUrl).toString();
  const init = await mcpCall(io, url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kairoku-cli", version: "0" } },
  });
  if (init.status === 401) throw new Error("unauthorized (401) — the app rejected the minted token");
  if (init.status < 200 || init.status >= 300) throw new Error(`initialize failed: HTTP ${init.status}`);
  const initBody = init.json as { error?: { message?: string } } | undefined;
  if (initBody?.error) throw new Error(`initialize error: ${initBody.error.message ?? "unknown"}`);

  const list = await mcpCall(
    io,
    url,
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.sessionId,
  );
  if (list.status === 401) throw new Error("unauthorized (401) — the app rejected the minted token");
  if (list.status < 200 || list.status >= 300) throw new Error(`tools/list failed: HTTP ${list.status}`);
  const listBody = list.json as { result?: { tools?: unknown[] }; error?: { message?: string } } | undefined;
  if (listBody?.error) throw new Error(`tools/list error: ${listBody.error.message ?? "unknown"}`);
  return { toolCount: listBody?.result?.tools?.length ?? 0 };
}

export async function run(args: string[], io: Io): Promise<number> {
  let values: { "app-url"?: string; resource?: string; replace?: boolean; help?: boolean };
  try {
    values = parseArgs({
      args,
      options: {
        "app-url": { type: "string" },
        resource: { type: "string" },
        replace: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${usage}`);
    return 2;
  }
  if (values.help) {
    io.out(usage);
    return 0;
  }

  const existing = readMcpLogin(io);
  if (existing && !values.replace) {
    io.err(
      `already signed in to ${existing.appUrl} (workspace ${existing.ownerId}) — pass --replace to sign in again, or \`kairoku logout\` first`,
    );
    return 1;
  }

  const appUrl = normaliseAppUrl(values["app-url"] ?? existing?.appUrl ?? DEFAULT_APP_URL);
  const name = `cli:${hostname()}`;

  let captured: LinkPersistPayload | undefined;
  let listener: ReturnType<typeof listenForLink>;
  try {
    listener = listenForLink({
      appUrl,
      purpose: "mcp",
      name,
      persist: (payload) => {
        captured = payload;
      },
    });
  } catch (e) {
    io.err(`could not open a callback listener — ${(e as Error).message}`);
    return 1;
  }

  io.out(`   … waiting for ${listener.linkUrl}`);
  await openLink(io, listener.linkUrl);
  const outcome = await listener.outcome;
  listener.close();

  if (!outcome.ok) {
    io.err(`login failed: ${outcome.reason}`);
    return 1;
  }
  if (!captured?.token || !captured.ownerId || !captured.resource) {
    io.err("login failed: the app did not return a token, ownerId and resource");
    return 1;
  }
  const { token, ownerId } = captured;
  const expectedResource = values.resource ?? captured.resource;

  try {
    const metadataResource = await fetchMetadataResource(io, appUrl);
    if (metadataResource !== expectedResource) {
      throw new Error(`resource metadata mismatch: the app says ${metadataResource}, expected ${expectedResource}`);
    }
    const { toolCount } = await proveMcpAccess(io, appUrl, token);
    setTokenEnv(io, "KAIROKU_MCP_TOKEN", token);
    writeMcpLogin(io, { appUrl, ownerId, resource: expectedResource });
    io.out(`✔ signed in — workspace ${ownerId}, ${toolCount} tool(s) available at ${appUrl}`);
    return 0;
  } catch (e) {
    io.err(`login failed: ${(e as Error).message}`);
    return 1;
  }
}

export async function logoutRun(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(logoutUsage);
    return 0;
  }
  const mcp = readMcpLogin(io);
  const tokenPath = join(kairokuHome(io.home), "token.env");
  const existing = io.exists(tokenPath) ? io.readFile(tokenPath) : null;
  if (existing !== null) {
    const kept = existing.split("\n").filter((line) => !/^\s*KAIROKU_MCP_TOKEN\s*=/.test(line));
    const body = kept.join("\n").replace(/\n+$/, "");
    io.writeFile(tokenPath, body ? `${body}\n` : "", 0o600);
  }
  if (mcp) writeMcpLogin(io, null);

  const appUrl = mcp?.appUrl ?? DEFAULT_APP_URL;
  io.out(`Removed the local Kairoku MCP token${mcp ? "" : " (none was recorded)"}.`);
  io.out(`To revoke it server side, visit ${appUrl}/settings/tokens and revoke the row named cli:${hostname()}.`);
  return 0;
}
