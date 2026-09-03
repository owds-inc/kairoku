import { afterEach, describe, expect, test } from "bun:test";
import {
  allocatePorts,
  composeDown,
  composeProjects,
  composeUp,
  parsePortRange,
  projectName,
  releasePorts,
  reserved,
  type ComposeDeps,
} from "./compose";
import type { CommandResult } from "./worktree";

afterEach(() => {
  for (const port of [...reserved()]) releasePorts({ p: port });
});

describe("parsePortRange", () => {
  test.each([
    ["20000-29999", { from: 20000, to: 29999 }],
    [" 3000 - 3100 ", { from: 3000, to: 3100 }],
  ])("%p parses", (text, range) => {
    expect(parsePortRange(text)).toEqual(range);
  });

  test.each(["", "nonsense", "29999-20000", "0-100", "20000-70000", "20000"])(
    "%p is refused rather than half-understood",
    (text) => {
      expect(parsePortRange(text)).toBeUndefined();
    },
  );
});

describe("allocatePorts — a bind probe, and a reservation nobody else can take", () => {
  test("one free port per name, all inside the range", () => {
    const ports = allocatePorts(["PG_PORT", "PROXY_PORT"], { from: 21000, to: 21100 });
    expect(Object.keys(ports).sort()).toEqual(["PG_PORT", "PROXY_PORT"]);
    for (const port of Object.values(ports)) {
      expect(port).toBeGreaterThanOrEqual(21000);
      expect(port).toBeLessThanOrEqual(21100);
    }
    expect(ports.PG_PORT).not.toBe(ports.PROXY_PORT);
  });

  test("a port a probe says is busy is skipped", () => {
    const busy = new Set([21000, 21001]);
    const ports = allocatePorts(["A"], { from: 21000, to: 21002 }, { probe: (p) => !busy.has(p) });
    expect(ports.A).toBe(21002);
  });

  test("TWO CONCURRENT RUNS NEVER GET THE SAME PORT, even in the window before either binds", () => {
    // The bind probe closes the socket before compose opens it. Without a
    // process-wide reservation the second member of the same daemon probes the
    // same free number a millisecond later and both write it into their compose.
    const first = allocatePorts(["A"], { from: 21500, to: 21501 });
    const second = allocatePorts(["A"], { from: 21500, to: 21501 });
    expect(second.A).not.toBe(first.A);
  });

  test("a range with nothing free fails loudly, naming the range", () => {
    expect(() => allocatePorts(["A"], { from: 21000, to: 21001 }, { probe: () => false })).toThrow(
      /21000-21001/,
    );
  });

  test("releasePorts hands the numbers back", () => {
    const ports = allocatePorts(["A"], { from: 21900, to: 21900 });
    releasePorts(ports);
    expect(allocatePorts(["A"], { from: 21900, to: 21900 })).toEqual(ports);
  });

  test("no names asked for is no ports allocated", () => {
    expect(allocatePorts([], { from: 21000, to: 21001 })).toEqual({});
  });
});

describe("projectName", () => {
  test("one compose project per run", () => {
    expect(projectName("6f1c9a2e-0d3b-4c88-9f21-0b2f1a7e5c44")).toBe(
      "kairoku-6f1c9a2e-0d3b-4c88-9f21-0b2f1a7e5c44",
    );
  });

  test("compose only accepts [a-z0-9_-], so anything else becomes a dash", () => {
    expect(projectName("Run/One.2")).toBe("kairoku-run-one-2");
  });
});

describe("compose up and down", () => {
  function recorder(result: Partial<CommandResult> = {}) {
    const calls: Array<{ argv: string[]; cwd: string; env?: Record<string, string> }> = [];
    const deps: ComposeDeps = {
      exec: async (argv, cwd, env) => {
        calls.push({ argv, cwd, ...(env === undefined ? {} : { env }) });
        return { code: 0, stdout: "", stderr: "", ...result };
      },
    };
    return { calls, deps };
  }

  test("up is `-p <project> -f <file> up --wait` with the ports exported", async () => {
    const { calls, deps } = recorder();
    const result = await composeUp(
      { project: "kairoku-r1", file: "compose.test.yml", cwd: "/w", env: { PG_PORT: "21000" } },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(calls[0]!.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "kairoku-r1",
      "-f",
      "compose.test.yml",
      "up",
      "--wait",
    ]);
    expect(calls[0]!.cwd).toBe("/w");
    expect(calls[0]!.env).toEqual({ PG_PORT: "21000" });
  });

  test("a failing up reports the tail, so the run says WHY the services never came", async () => {
    const { deps } = recorder({ code: 1, stderr: "error: port is already allocated" });
    const result = await composeUp({ project: "kairoku-r1", file: "c.yml", cwd: "/w", env: {} }, deps);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("port is already allocated");
  });

  test("down takes the VOLUMES with it — two runs must not share a byte", async () => {
    const { calls, deps } = recorder();
    await composeDown({ project: "kairoku-r1", file: "c.yml", cwd: "/w", env: {} }, deps);
    expect(calls[0]!.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "kairoku-r1",
      "-f",
      "c.yml",
      "down",
      "-v",
      "--remove-orphans",
    ]);
  });

  test("down without a compose file still names the project — prune has no file to point at", async () => {
    const { calls, deps } = recorder();
    await composeDown({ project: "kairoku-r1", cwd: "/w", env: {} }, deps);
    expect(calls[0]!.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "kairoku-r1",
      "down",
      "-v",
      "--remove-orphans",
    ]);
  });
});

describe("composeProjects — what prune is offered", () => {
  const listing = (stdout: string): ComposeDeps => ({
    exec: async () => ({ code: 0, stdout, stderr: "" }),
  });

  test("only this daemon's per-run projects", async () => {
    expect(await composeProjects(listing("kairoku-r1\nkairoku-r2\nsomething-else\n"))).toEqual([
      "kairoku-r1",
      "kairoku-r2",
    ]);
  });

  test("a developer's own `kairoku` project is NOT a per-run project and is left alone", async () => {
    // The bare name is what `docker compose up` in the app checkout creates.
    // Prune taking it down would stop the machine owner's own database.
    expect(await composeProjects(listing("kairoku\nkairoku-r1\n"))).toEqual(["kairoku-r1"]);
  });

  test("no docker, or docker not running, is an empty list rather than a crash", async () => {
    expect(await composeProjects({ exec: async () => ({ code: 1, stdout: "", stderr: "no" }) })).toEqual([]);
  });
});
