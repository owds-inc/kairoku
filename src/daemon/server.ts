/**
 * HTTP surface (RF-001..RF-006) and the daemon entrypoint.
 *
 * Five routes, a plain route table, no framework. Every route is behind the
 * bearer check; the listener binds only to the configured host.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { assertBindable, loadConfig, migrateHome, type Config } from "./config";
import { RunStore, type RefusalReason, type RunRequest } from "./runs";

/** RF-006 — constant-time bearer comparison, length-independent via SHA-256. */
export function tokenMatches(offered: string, expected: string): boolean {
  const a = createHash("sha256").update(offered).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

const REFUSAL_STATUS: Record<RefusalReason, number> = {
  empty_brief: 400,
  unknown_role: 400,
  missing_credential: 400,
  duplicate_credential: 409,
  capacity_full: 429,
};

export interface Daemon {
  readonly store: RunStore;
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

export function createDaemon(config: Config): Daemon {
  assertBindable(config.listen.host);
  const store = new RunStore(config);

  const guard =
    (handler: (req: Request) => Response | Promise<Response>) =>
    (req: Request): Response | Promise<Response> => {
      if (!tokenMatches(bearer(req), config.token)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return handler(req);
    };

  const server = Bun.serve({
    hostname: config.listen.host,
    port: config.listen.port,
    routes: {
      "/capacity": {
        GET: guard(() => Response.json(store.capacity())),
      },
      "/runs": {
        POST: guard(async (req) => {
          let body: RunRequest;
          try {
            body = (await req.json()) as RunRequest;
          } catch {
            return Response.json({ reason: "empty_brief" }, { status: 400 });
          }
          const result = store.create(body);
          if (!result.ok) {
            return Response.json(
              { reason: result.reason },
              { status: REFUSAL_STATUS[result.reason] },
            );
          }
          return Response.json({ runId: result.runId }, { status: 201 });
        }),
      },
      "/runs/:id": {
        GET: guard((req) => {
          const id = (req as Bun.BunRequest<"/runs/:id">).params.id;
          const view = store.view(id);
          return view
            ? Response.json(view)
            : Response.json({ error: "not_found" }, { status: 404 });
        }),
      },
      "/runs/:id/cancel": {
        POST: guard((req) => {
          const id = (req as Bun.BunRequest<"/runs/:id/cancel">).params.id;
          return store.cancel(id)
            ? Response.json({ cancelled: true })
            : Response.json({ error: "not_found" }, { status: 404 });
        }),
      },
    },
    fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
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
  const daemon = createDaemon(config);
  console.log(`kairoku daemon listening on ${daemon.url} (max ${config.maxConcurrent})`);

  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: tearing down runs`);
      await daemon.stop();
      resolve(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  });
}

if (import.meta.main) process.exit(await serve());
