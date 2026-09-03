import { describe, expect, test } from "bun:test";
import { machineMeta } from "./models";
import { harness } from "./testkit";

const stub = (models: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(models).map(([name, list]) => [name, async () => list]));

describe("models — what a machine advertises (§20 item 2)", () => {
  test("protocol, host, version, capacity, repos, providers and recipes", async () => {
    const h = harness();
    const meta = await machineMeta(h.config, {
      repos: async () => ["owds-inc/kairoku"],
      capacity: () => ({ running: 1, max: 2 }),
      models: stub({ claude: ["claude-opus-5"], codex: ["gpt-5.6-sol"] }),
    });
    h.cleanup();

    expect(meta.protocol).toBe("1");
    expect(meta.capacity).toEqual({ running: 1, max: 2 });
    expect(meta.repos).toEqual(["owds-inc/kairoku"]);
    expect(meta.providers).toEqual({ claude: ["claude-opus-5"], codex: ["gpt-5.6-sol"] });
    expect(meta.recipes).toEqual(["solo", "build-verify", "phase-team", "plan", "research", "custom"]);
    expect(meta.host.length).toBeGreaterThan(0);
    expect(meta.version.length).toBeGreaterThan(0);
  });

  test("the models are asked for ONCE per daemon, then cached", async () => {
    const h = harness();
    let asks = 0;
    const deps = {
      repos: async () => ["owds-inc/kairoku"],
      capacity: () => ({ running: 0, max: 2 }),
      models: {
        claude: async () => {
          asks++;
          return ["claude-opus-5"];
        },
      },
    };
    await machineMeta(h.config, deps);
    await machineMeta(h.config, deps);
    await machineMeta(h.config, deps);
    h.cleanup();
    expect(asks).toBe(1);
  });

  test("capacity is NOT cached — it is the number that changes every beat", async () => {
    const h = harness();
    let running = 0;
    const deps = { repos: async () => [], capacity: () => ({ running, max: 2 }), models: {} };
    expect((await machineMeta(h.config, deps)).capacity).toEqual({ running: 0, max: 2 });
    running = 2;
    expect((await machineMeta(h.config, deps)).capacity).toEqual({ running: 2, max: 2 });
    h.cleanup();
  });

  test("a provider that advertises nothing is left out, not sent as an empty list", async () => {
    // An empty list and an absent key mean different things to the composer:
    // "this machine can run codex but has no models" versus "no codex here".
    const h = harness();
    const meta = await machineMeta(h.config, {
      repos: async () => [],
      capacity: () => ({ running: 0, max: 1 }),
      models: stub({ claude: ["claude-opus-5"], codex: [] }),
    });
    h.cleanup();
    expect(meta.providers).toEqual({ claude: ["claude-opus-5"] });
  });

  test("an unreadable checkout advertises no repos, and the claim filter then offers nothing", async () => {
    const h = harness();
    const meta = await machineMeta(h.config, {
      repos: async () => [],
      capacity: () => ({ running: 0, max: 1 }),
      models: {},
    });
    h.cleanup();
    expect(meta.repos).toEqual([]);
  });
});
