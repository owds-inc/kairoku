/**
 * THE O-4 DONE-CONDITION, RUN FOR REAL — with real Docker.
 *
 * Two `build-verify` members on one machine at the same time, each getting its
 * own compose project and its own allocated port, both QA steps reporting
 * counts, and nothing left behind. Everything here is production code except
 * three things, each of which cannot exist in a test on principle: the APP is
 * the fake one (`Bun.serve` speaking the three routes), the MODEL is a scripted
 * provider, and the REPO is a fixture whose services are one redis rather than
 * the app's postgres-and-proxy. The manifest, the merge, the port allocation,
 * the compose project, the init step, the QA step and the teardown are the ones
 * that ship.
 *
 * The same shape against the real app and the real app repo (postgres + proxy,
 * `bun run db:migrate`) needs a browser-minted daemon token and a checkout of
 * the app, so it is a human gate rather than a test — it is listed in the PR
 * body.
 *
 * IT SKIPS RATHER THAN FAILS where Docker is not usable or the fixture image is
 * not local, and says so in the counts: a machine without Docker is a machine
 * this lane deliberately still supports (`no manifest → today's behaviour`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appClient } from "./app";
import { composeDown, composeProjects, dockerVersion } from "./compose";
import { envStorePath, writeEnvStore } from "./env";
import { startLink, type Link } from "./link";
import type { LaunchedRun, Provider, RoleRun } from "./providers";
import { RunStore } from "./runs";
import { fakeApp, fakeItem, fakeWorktrees, harness, waitFor, type FakeApp, type Harness } from "./testkit";
import { run as sh } from "./worktree";

const IMAGE = "redis:7-alpine";
/** Unique per suite run, so nothing here can collide with another run's project. */
const STAMP = Math.random().toString(36).slice(2, 8);
const runIdOf = (n: number) => `o4-${STAMP}-${n}`;

let active: Harness | undefined;
let app: FakeApp | undefined;
let link: Link | undefined;

afterEach(async () => {
  link?.stop();
  link = undefined;
  await app?.stop();
  app = undefined;
  // Belt and braces: if an assertion threw before teardown, take the projects
  // down anyway rather than leaving containers on somebody's laptop.
  for (const n of [1, 2]) {
    await composeDown({ project: `kairoku-${runIdOf(n)}`, cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
  }
  active?.cleanup();
  active = undefined;
});

/** Docker usable AND the fixture image already local — no test pulls an image. */
async function dockerReady(): Promise<string | undefined> {
  if (!(await dockerVersion())) return "docker compose is not usable on this machine";
  const image = await sh(["docker", "image", "inspect", IMAGE], process.cwd());
  return image.code === 0 ? undefined : `${IMAGE} is not present locally`;
}

const MANIFEST = JSON.stringify({
  $comment: "The O-4 fixture: one service, one allocated port, one init probe.",
  env: {
    test: {
      files: [".env.local"],
      compose: "compose.fixture.yml",
      ports: ["REDIS_PORT"],
      inject: { REDIS_URL: "redis://127.0.0.1:${REDIS_PORT}" },
      init: ["bun probe.ts"],
    },
  },
  check: ["true"],
  test: "sh ./run-tests.sh",
  concurrency: { test: 2 },
});

const COMPOSE = `services:
  cache:
    image: ${IMAGE}
    ports:
      - '127.0.0.1:\${REDIS_PORT}:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 1s
      timeout: 2s
      retries: 30
`;

/**
 * The init step: connect to the port the daemon allocated and record it. A
 * healthy container proves compose worked; a TCP connect on THIS number proves
 * the run got the port it was told it had.
 */
const PROBE = `const port = Number(process.env.REDIS_PORT);
const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
socket.end();
await Bun.write(\`\${process.env.OUT_DIR}/\${process.env.KAIROKU_RUN_ID}.probe\`, String(port));
`;

/** The suite: four countable numbers, and a record of the env it was given. */
const RUNNER = `#!/bin/sh
printf '%s' "$REDIS_URL" > "$OUT_DIR/$KAIROKU_RUN_ID.suite"
printf ' 5 pass\\n 0 fail\\n'
`;

function fixtureWorktrees(root: string) {
  const base = fakeWorktrees(root);
  return {
    ...base,
    async create(name: string, from?: string) {
      const worktree = await base.create(name, from);
      writeFileSync(join(worktree.path, "compose.fixture.yml"), COMPOSE);
      writeFileSync(join(worktree.path, "probe.ts"), PROBE);
      writeFileSync(join(worktree.path, "run-tests.sh"), RUNNER);
      // Layer 1: the checkout's own dotenv, which the store must beat.
      writeFileSync(join(worktree.path, ".env.local"), "OUT_DIR=/this/is/overridden\nFROM_CHECKOUT=yes\n");
      return worktree;
    },
  };
}

/** A model that reviews clean and does nothing else. The environment is the subject. */
function cleanTeam(): Provider {
  return {
    name: "claude",
    models: async () => ["fake-model"],
    launch(run: RoleRun): LaunchedRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { kind: "text" as const, text: `${run.role} ran` };
          },
        },
        interrupt() {},
        exit: Promise.resolve({
          ok: true,
          summary: `${run.role} finished`,
          ...(run.role === "reviewer" ? { report: { verdict: "CLEAN", defects: [] } } : {}),
        }),
      };
    },
  };
}

describe("the O-4 done-condition, with real Docker", () => {
  test(
    "two members at once: their own compose project, their own port, counts from each, nothing left behind",
    async () => {
      const why = await dockerReady();
      if (why) {
        console.log(`SKIPPED (${why}) — the environments done-condition needs real Docker`);
        return;
      }

      app = fakeApp();
      const h = (active = harness({ maxConcurrent: 2, appUrl: app.url, token: app.token, ports: "24000-24999" }));
      const fake = app;
      const out = join(h.dir, "out");
      mkdirSync(out, { recursive: true });

      // A real checkout with the manifest on its base branch — the daemon reads
      // it from there, never from the worktree.
      const repo = h.config.repoPath;
      mkdirSync(repo, { recursive: true });
      await sh(["git", "init", "-q", "-b", "main"], repo);
      await sh(["git", "config", "user.email", "daemon@example.com"], repo);
      await sh(["git", "config", "user.name", "daemon"], repo);
      await sh(["git", "remote", "add", "origin", "https://github.com/owds-inc/kairoku.git"], repo);
      writeFileSync(join(repo, "kairoku.json"), MANIFEST);
      await sh(["git", "add", "-A"], repo);
      await sh(["git", "commit", "-qm", "the environment contract"], repo);
      await sh(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], repo);

      // Layer 2, for real: the daemon's own env store beats the checkout's file.
      writeEnvStore(envStorePath(h.config.envDir, "owds-inc/kairoku", "test"), { OUT_DIR: out, FROM_STORE: "yes" });

      const config = { ...h.config, worktreeOps: fixtureWorktrees(h.config.worktreesDir) };
      const store = new RunStore(config);
      const provider = cleanTeam();
      const l = (link = startLink(store, config, {
        client: appClient({ appUrl: fake.url, token: fake.token }),
        autostart: false,
        log: () => {},
        providers: { claude: provider, codex: provider },
      }));
      await l.beat();

      fake.queue({
        id: `d-${STAMP}`,
        taskType: "implement",
        target: { kind: "phase", id: "ph1", title: "Phase one" },
        repo: { provider: "github", fullName: "owds-inc/kairoku", defaultBranch: "main" },
        team: { recipe: "phase-team", roles: {} },
        env: { profile: "test", secrets: { FROM_APP: "sekrit-app-value" } },
        items: [1, 2].map((n) => fakeItem(n, { runId: runIdOf(n) })),
      });

      expect(await l.poll()).toBe(true);
      await waitFor(() => store.list().length === 2, "two members at once", 60_000);

      await waitFor(
        () => [...fake.runs.values()].every((row) => row.status === "done" || row.status === "failed"),
        "both members to settle",
        120_000,
      );

      // Both ran their suite and reported all four counts.
      for (const [runId, row] of fake.runs) {
        expect({ [runId]: row.status, summary: row.summary }).toEqual({ [runId]: "done", summary: row.summary });
        expect(row.counts).toEqual({ pass: 5, fail: 0, skip: 0, errors: 0 });
      }

      // Each got a DIFFERENT port, and the init probe reached a redis on it.
      const ports = [1, 2].map((n) => {
        const state = JSON.parse(
          readFileSync(join(h.config.runsDir, `d-${STAMP}`, `${runIdOf(n)}.json`), "utf8"),
        ) as { ports?: Record<string, number> };
        return state.ports!.REDIS_PORT!;
      });
      expect(ports[0]).not.toBe(ports[1]);
      for (const [i, n] of [1, 2].entries()) {
        expect(readFileSync(join(out, `${runIdOf(n)}.probe`), "utf8")).toBe(String(ports[i]));
        // The suite got the injected value, built from ITS OWN port.
        expect(readFileSync(join(out, `${runIdOf(n)}.suite`), "utf8")).toBe(`redis://127.0.0.1:${ports[i]}`);
      }

      // Layer 2 beat layer 1: the checkout's `.env.local` said OUT_DIR was
      // somewhere else, and nothing was written there.
      expect(existsSync("/this/is/overridden")).toBe(false);

      // The app's delivered secret never reached either log.
      for (const n of [1, 2]) {
        const log = readFileSync(join(h.config.runsDir, `d-${STAMP}`, `${runIdOf(n)}.jsonl`), "utf8");
        expect(log).not.toContain("sekrit-app-value");
      }

      // `docker ps` is clean: neither per-run project is left standing.
      const left = await composeProjects();
      for (const n of [1, 2]) expect(left).not.toContain(`kairoku-${runIdOf(n)}`);
    },
    180_000,
  );
});
