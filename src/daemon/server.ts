/**
 * The loopback listener (RF-005, RF-006) and the daemon entrypoint.
 *
 * SPEC v1, §20.3: the push API is retired. `POST /runs`, `GET /runs/:id`,
 * `POST /runs/:id/cancel` and the inbound bearer are gone — runs start in the
 * app, and this surface exists only so `kairoku doctor` can ask a daemon on
 * this machine how it is doing.
 *
 * GET `/status` and `/capacity` stay unauthenticated: reachability on
 * 127.0.0.1 IS the trust boundary. POST `/drain` is an explicit amendment —
 * an independent 256-bit `drain.token` (never the cloud or run token), same-user
 * 0700/0600 files, loopback bind only, Host/Origin checks. Never expose drain
 * on a LAN address.
 */

import { version } from "../../package.json";
import {
  assertBindable,
  configDirOf,
  drainTokensEqual,
  ensureDrainToken,
  inspectDrainToken,
  isLoopbackHost,
  loadConfig,
  loadHumanDrain,
  migrateHome,
  persistHumanDrain,
  type Config,
} from "./config";
import { startLink, type Link, type LinkStatus } from "./link";
import { RunStore } from "./runs";

/** What `/status` reports about the app link. `link.ts` owns the shape. */
export interface LinkView {
  status(): LinkStatus;
  setDraining?(draining: boolean): void;
}

export interface DaemonDeps {
  readonly store?: RunStore;
  readonly link?: LinkView;
  /** Test seam: cloud drain POST. Defaults to `fetch`. */
  readonly cloudDrain?: (config: Config) => Promise<"draining" | "pending">;
}

export interface Daemon {
  readonly store: RunStore;
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
const forbidden = (reason: string) => Response.json({ error: "forbidden", reason }, { status: 403 });
const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

function hostName(header: string | null): string {
  if (!header) return "";
  const raw = header.trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(":")[0] ?? "";
}

function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

async function defaultCloudDrain(config: Config): Promise<"draining" | "pending"> {
  if (!config.appUrl || !config.token) return "pending";
  try {
    const res = await fetch(`${config.appUrl}/api/daemon/drain`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "draining" }),
    });
    if (!res.ok) return "pending";
    const body = (await res.json()) as { ok?: unknown; admissionMode?: unknown };
    return body.ok === true && body.admissionMode === "draining" ? "draining" : "pending";
  } catch {
    return "pending";
  }
}

export function createDaemon(config: Config, deps: DaemonDeps = {}): Daemon {
  assertBindable(config.listen.host);
  const store = deps.store ?? new RunStore(config);
  const configDir = configDirOf(config);
  const cloudDrain = deps.cloudDrain ?? defaultCloudDrain;
  ensureDrainToken(configDir);

  const server = Bun.serve({
    hostname: config.listen.host,
    port: config.listen.port,
    routes: {
      "/capacity": { GET: () => Response.json(store.capacity()) },
      "/status": {
        GET: () =>
          Response.json({
            version,
            capacity: store.capacity(),
            link: deps.link?.status() ?? { linked: false },
            runs: store.list(),
          }),
      },
      "/drain": {
        POST: async (req: Request) => {
          if (!isLoopbackHost(config.listen.host)) {
            return forbidden("drain is not exposed on a non-loopback bind");
          }
          const host = hostName(req.headers.get("host"));
          if (!isLoopbackHost(host)) {
            return forbidden("unexpected Host");
          }
          const origin = originHost(req.headers.get("origin"));
          if (origin !== null && !isLoopbackHost(origin)) {
            return forbidden("unexpected Origin");
          }
          const inspected = inspectDrainToken(configDir);
          if (!inspected.ok) return forbidden(inspected.reason);
          const presented = bearer(req.headers.get("authorization"));
          if (!presented || !drainTokensEqual(presented, inspected.token)) {
            return unauthorized();
          }
          persistHumanDrain(configDir);
          deps.link?.setDraining?.(true);
          const cloud = await cloudDrain(config);
          const status = deps.link?.status();
          return Response.json({
            local: "draining",
            cloud,
            activeAttempts: store.capacity().running,
            pendingReports: status?.pendingReports ?? 0,
          });
        },
      },
    },
    fetch: notFound,
  });

  const port = server.port ?? config.listen.port;
  return {
    store,
    url: `http://${config.listen.host}:${port}`,
    port,
    async stop() {
      await store.shutdown();
      await server.stop(true);
    },
  };
}

/**
 * Run the daemon in the foreground until SIGTERM/SIGINT; resolves with the
 * exit code after teardown. `kairoku daemon` and `bun run src/daemon/server.ts`
 * both land here.
 */
export function serve(): Promise<number> {
  const migrated = migrateHome();
  if (migrated === "migrated") console.log(`migrated ~/.hikyaku to ~/.kairoku (copied; the old dir is untouched)`);
  const config = loadConfig();
  const store = new RunStore(config);
  const link: Link = startLink(store, config);
  if (loadHumanDrain(configDirOf(config))) link.setDraining(true);
  const daemon = createDaemon(config, { store, link });
  console.log(`kairoku daemon listening on ${daemon.url} (max ${config.maxConcurrent})`);

  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: tearing down runs`);
      link.stop();
      await daemon.stop();
      resolve(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  });
}

if (import.meta.main) process.exit(await serve());
