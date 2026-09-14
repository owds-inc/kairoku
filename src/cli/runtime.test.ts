import { describe, expect, test } from "bun:test";
import { fakeIo } from "./testkit";
import {
  chooseSetupAction,
  decideFromInventory,
  probeRustLiveHealth,
  resolveRuntime,
  type Installation,
} from "./runtime";

const sample: Installation = {
  schemaVersion: 1,
  installationId: "inst-1",
  dataRoot: "/home/tester/.local/share/kairokud",
  profile: "linux-personal",
  executionUser: "tester",
  executable: "/home/tester/.local/bin/kairokud",
  service: {
    manager: "systemd",
    scope: "user",
    label: "kairokud",
    package: "direct",
  },
};

describe("chooseSetupAction", () => {
  test("repeat setup preserves a matching running service", () => {
    expect(chooseSetupAction(1, true, true)).toBe("preserve");
    expect(chooseSetupAction(2, true, true)).toBe("refuse");
  });

  test("install when nothing is found", () => {
    expect(chooseSetupAction(0, false, false)).toBe("install");
  });

  test("start when matching but not running", () => {
    expect(chooseSetupAction(1, true, false)).toBe("start");
  });

  test("refuse a single non-matching owner", () => {
    expect(chooseSetupAction(1, false, true)).toBe("refuse");
  });
});

describe("decideFromInventory", () => {
  test("two detected service owners refuse without mutation", () => {
    const action = decideFromInventory({
      owners: ["homebrew:io.kairoku.daemon", "direct:io.kairoku.daemon"],
      matching: true,
      running: true,
    });
    expect(action).toBe("refuse");
  });
});

describe("resolveRuntime", () => {
  test("returns null when kairokud is absent", async () => {
    const io = fakeIo({ bins: new Set() });
    expect(await resolveRuntime(io)).toBeNull();
    expect(io.calls).toEqual([]);
  });

  test("returns null when installation metadata is absent", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        // fakeIo.which returns `/usr/bin/<bin>`; shell argv uses that path.
        "/usr/bin/kairokud instance --json": {
          code: 1,
          stderr: "error: no installation.json under /tmp/data — run configure first\n",
        },
      },
    });
    expect(await resolveRuntime(io)).toBeNull();
    expect(io.calls).toEqual([["/usr/bin/kairokud", "instance", "--json"]]);
  });

  test("parses kairokud instance --json without duplicating path computation", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud instance --json": { stdout: JSON.stringify(sample) + "\n" },
      },
    });
    const got = await resolveRuntime(io);
    expect(got).toEqual(sample);
    expect(io.calls).toEqual([["/usr/bin/kairokud", "instance", "--json"]]);
  });

  test("throws on corrupt JSON without writing files", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud instance --json": { stdout: "{not-json" },
      },
    });
    await expect(resolveRuntime(io)).rejects.toThrow(/corrupt JSON/);
    expect(Object.keys(io.files)).toHaveLength(0);
  });

  test("throws on ambiguous failure without mutation", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud instance --json": {
          code: 1,
          stderr: "error: ambiguous service ownership (2 owners); refuse\n",
        },
      },
    });
    await expect(resolveRuntime(io)).rejects.toThrow(/failed/);
    expect(Object.keys(io.files)).toHaveLength(0);
  });

  test("throws on unrelated not-found stderr instead of treating as absent", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud instance --json": {
          code: 127,
          stderr: "error: shared library not found\n",
        },
      },
    });
    await expect(resolveRuntime(io)).rejects.toThrow(/failed/);
    expect(Object.keys(io.files)).toHaveLength(0);
  });
});

describe("probeRustLiveHealth", () => {
  test("requires heartbeatOk plus identity fields from status --json", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud status --json": {
          code: 0,
          stdout: JSON.stringify({
            installationId: "inst-1",
            daemonId: "daemon-1",
            ownerId: "owner-1",
            processInstanceId: "proc-1",
            backendUrl: "https://app.kairoku.dev",
            heartbeatOk: true,
          }),
        },
      },
    });
    const health = await probeRustLiveHealth(io, 1);
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("daemon-1");
  });

  test("offline or incomplete status is not live proof", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud status --json": {
          code: 0,
          stdout: JSON.stringify({
            installationId: "inst-1",
            daemonId: "daemon-1",
            ownerId: "owner-1",
            processInstanceId: "proc-1",
            heartbeatOk: false,
          }),
        },
      },
    });
    const health = await probeRustLiveHealth(io, 1);
    expect(health.ok).toBe(false);
  });

  test("missing backend identity is not live proof", async () => {
    const io = fakeIo({
      bins: new Set(["kairokud"]),
      canned: {
        "/usr/bin/kairokud status --json": {
          code: 0,
          stdout: JSON.stringify({
            installationId: "inst-1",
            daemonId: "daemon-1",
            ownerId: "owner-1",
            processInstanceId: "proc-1",
            heartbeatOk: true,
          }),
        },
      },
    });

    expect((await probeRustLiveHealth(io, 1)).ok).toBe(false);
  });
});
