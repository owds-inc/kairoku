import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePorts, reserved } from "./compose";
import { envStorePath, writeEnvStore } from "./env";
import { prepareEnvironment, type EnvironmentDeps } from "./environment";
import { parseManifest, type Manifest } from "./manifest";

afterEach(() => {
  for (const port of [...reserved()]) releasePorts({ p: port });
});

const RANGE = { from: 22000, to: 22200 };

function manifestOf(source: unknown): Manifest {
  const parsed = parseManifest(JSON.stringify(source));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

const FULL = manifestOf({
  env: {
    test: {
      files: [".env.local"],
      compose: "compose.test.yml",
      ports: ["PG_PORT", "PROXY_PORT"],
      inject: {
        DATABASE_URL: "postgres://127.0.0.1:${PG_PORT}/main",
        NEON_PROXY_URL: "http://127.0.0.1:${PROXY_PORT}/sql",
      },
      init: ["bun run db:migrate"],
    },
  },
});

interface Recorded {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

function deps(over: { upFails?: boolean; initFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  const record: EnvironmentDeps = {
    ports: { probe: () => true },
    compose: {
      exec: async (argv, cwd, env) => {
        calls.push({ argv, cwd, env: env ?? {} });
        const failing = over.upFails && argv.includes("up");
        return { code: failing ? 1 : 0, stdout: "", stderr: failing ? "port is already allocated" : "" };
      },
    },
    exec: async (argv, cwd, env) => {
      calls.push({ argv, cwd, env: env ?? {} });
      return { code: over.initFails ? 1 : 0, stdout: "migrating", stderr: over.initFails ? "relation missing" : "" };
    },
  };
  return { calls, deps: record };
}

function spec(over: Record<string, unknown> = {}) {
  return {
    dispatchId: "d1",
    runId: "run-1",
    worktree: "/w",
    repoFullName: "owds-inc/kairoku",
    profileName: "test",
    manifest: FULL,
    secrets: {},
    perRun: { KAIROKU_PAT: "kai_run_1" },
    portRange: RANGE,
    home: "/nowhere",
    ...over,
  } as Parameters<typeof prepareEnvironment>[0];
}

describe("prepareEnvironment — the whole profile, for one run", () => {
  test("allocates the named ports and substitutes them into inject", async () => {
    const { deps: d } = deps();
    const env = await prepareEnvironment(spec(), d);
    expect(env.ok).toBe(true);
    const pg = env.ports.PG_PORT!;
    const proxy = env.ports.PROXY_PORT!;
    expect(pg).not.toBe(proxy);
    expect(env.values.PG_PORT).toBe(String(pg));
    expect(env.values.DATABASE_URL).toBe(`postgres://127.0.0.1:${pg}/main`);
    expect(env.values.NEON_PROXY_URL).toBe(`http://127.0.0.1:${proxy}/sql`);
    await env.teardown();
  });

  test("compose runs as this run's OWN project, with the ports exported", async () => {
    const { calls, deps: d } = deps();
    const env = await prepareEnvironment(spec(), d);
    const up = calls.find((c) => c.argv.includes("up"))!;
    expect(up.argv.slice(0, 8)).toEqual([
      "docker",
      "compose",
      "-p",
      "kairoku-run-1",
      "-f",
      "compose.test.yml",
      "up",
      "--wait",
    ]);
    expect(up.cwd).toBe("/w");
    expect(up.env.PG_PORT).toBe(String(env.ports.PG_PORT));
    await env.teardown();
  });

  test("init runs AFTER the services, in the worktree, with the merged environment", async () => {
    const { calls, deps: d } = deps();
    const env = await prepareEnvironment(spec(), d);
    const upAt = calls.findIndex((c) => c.argv.includes("up"));
    const initAt = calls.findIndex((c) => c.argv.join(" ").includes("db:migrate"));
    expect(upAt).toBeLessThan(initAt);
    expect(calls[initAt]!.argv).toEqual(["sh", "-c", "bun run db:migrate"]);
    expect(calls[initAt]!.cwd).toBe("/w");
    expect(calls[initAt]!.env.DATABASE_URL).toBe(env.values.DATABASE_URL);
    await env.teardown();
  });

  test("the run's credential and ids are the TOP layer — a manifest cannot shadow them", async () => {
    const shadowing = manifestOf({
      env: { test: { inject: { KAIROKU_PAT: "stolen", DATABASE_URL: "x" } } },
    });
    const { deps: d } = deps();
    const env = await prepareEnvironment(spec({ manifest: shadowing }), d);
    expect(env.values.KAIROKU_PAT).toBe("kai_run_1");
    expect(env.values.KAIROKU_RUN_ID).toBe("run-1");
    expect(env.values.KAIROKU_DISPATCH_ID).toBe("d1");
    await env.teardown();
  });

  test("the four layers, in order, end to end", async () => {
    const home = mkdtempSync(join(tmpdir(), "kairoku-prep-"));
    const worktree = mkdtempSync(join(tmpdir(), "kairoku-wt-"));
    try {
      writeFileSync(join(worktree, ".env.local"), "A=checkout\nB=checkout\nC=checkout\n");
      writeEnvStore(envStorePath(home, "owds-inc/kairoku", "test"), { B: "store", C: "store" });
      const { deps: d } = deps();
      const env = await prepareEnvironment(
        spec({ home, worktree, secrets: { C: "secret" }, manifest: FULL }),
        d,
      );
      expect(env.values.A).toBe("checkout");
      expect(env.values.B).toBe("store");
      expect(env.values.C).toBe("secret");
      await env.teardown();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("no manifest is today's behaviour: no ports, no compose, no init, and the per-run values", async () => {
    const { calls, deps: d } = deps();
    const env = await prepareEnvironment(spec({ manifest: undefined }), d);
    expect(env.ok).toBe(true);
    expect(env.ports).toEqual({});
    expect(calls).toEqual([]);
    expect(env.values.KAIROKU_PAT).toBe("kai_run_1");
    await env.teardown();
  });

  test("a profile the manifest does not declare is refused rather than half-built", async () => {
    const { deps: d } = deps();
    const env = await prepareEnvironment(spec({ profileName: "staging" }), d);
    expect(env.ok).toBe(false);
    expect(env.summary).toContain("staging");
    await env.teardown();
  });

  test("a failing compose up fails the run with docker's own words, and releases the ports", async () => {
    const { deps: d } = deps({ upFails: true });
    const env = await prepareEnvironment(spec(), d);
    expect(env.ok).toBe(false);
    expect(env.summary).toContain("port is already allocated");
    await env.teardown();
    expect(reserved()).toEqual([]);
  });

  test("a failing init fails the run and names the command, and teardown still takes the project down", async () => {
    const { calls, deps: d } = deps({ initFails: true });
    const env = await prepareEnvironment(spec(), d);
    expect(env.ok).toBe(false);
    expect(env.summary).toContain("bun run db:migrate");
    await env.teardown();
    expect(calls.some((c) => c.argv.includes("down"))).toBe(true);
  });
});

describe("teardown — every exit path, and only once", () => {
  test("takes the volumes with it and hands the ports back", async () => {
    const { calls, deps: d } = deps();
    const env = await prepareEnvironment(spec(), d);
    const ports = Object.values(env.ports);
    expect(reserved().sort()).toEqual([...ports].sort());

    await env.teardown();
    const down = calls.find((c) => c.argv.includes("down"))!;
    expect(down.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "kairoku-run-1",
      "-f",
      "compose.test.yml",
      "down",
      "-v",
      "--remove-orphans",
    ]);
    expect(reserved()).toEqual([]);
  });

  test("is idempotent — cancel and normal exit can both reach it", async () => {
    const { calls, deps: d } = deps();
    const env = await prepareEnvironment(spec(), d);
    await env.teardown();
    await env.teardown();
    expect(calls.filter((c) => c.argv.includes("down"))).toHaveLength(1);
  });

  test("a down that itself fails does not throw into the run's exit path", async () => {
    const env = await prepareEnvironment(spec(), {
      ports: { probe: () => true },
      compose: { exec: async () => ({ code: 1, stdout: "", stderr: "docker daemon is not running" }) },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    // `up` failed, so this run is already a failure; teardown must still settle.
    expect(env.ok).toBe(false);
    await env.teardown();
    expect(reserved()).toEqual([]);
  });
});
