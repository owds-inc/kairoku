/**
 * The loopback listener (RF-005, RF-006) and the daemon entrypoint.
 *
 * SPEC v1, §20.3: the push API is retired. `POST /runs`, `GET /runs/:id`,
 * `POST /runs/:id/cancel` and the inbound bearer are gone — runs start in the
 * app, and this surface exists only so `kairoku doctor` can ask a daemon on
 * this machine how it is doing.
 *
 * There is therefore nothing to authenticate: reachability on 127.0.0.1 IS the
 * trust boundary. That is exactly why the wildcard refusal stays — an
 * unauthenticated surface on a LAN address would be a different bargain.
 */

import { version } from "../../package.json";
import { assertBindable, loadConfig, migrateHome, type Config } from "./config";
import { startLink, type LinkStatus } from "./link";
import { RunStore } from "./runs";

/** What `/status` reports about the app link. `link.ts` owns the shape. */
export interface LinkView {
  status(): LinkStatus;
}

export interface DaemonDeps {
  readonly store?: RunStore;
  readonly link?: LinkView;
}

export interface Daemon {
  readonly store: RunStore;
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

export function createDaemon(config: Config, deps: DaemonDeps = {}): Daemon {
  assertBindable(config.listen.host);
  const store = deps.store ?? new RunStore(config);

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
  const link = startLink(store, config);
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
