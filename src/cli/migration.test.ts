import { describe, expect, test } from "bun:test";
import {
  handoffComplete,
  inventoryPredecessor,
  loadReceipt,
  runMigration,
  type MigrationResult,
} from "./migration";
import type { Installation } from "./runtime";
import { fakeIo, type FakeIo } from "./testkit";

const installation: Installation = {
  schemaVersion: 1,
  installationId: "inst-rust-1",
  dataRoot: "/home/neil/.local/share/kairokud",
  profile: "linux-personal",
  executionUser: "neil",
  executable: "/usr/bin/kairokud",
  service: {
    manager: "systemd",
    scope: "user",
    label: "io.kairoku.daemon",
    package: "direct",
  },
};

function fixture(opts: { activeRuns?: number; statusOk?: boolean; statusBody?: unknown } = {}): FakeIo {
  const io = fakeIo({ platform: "linux", home: "/home/neil", uid: 1000, env: { USER: "neil" } });
  io.bins.add("kairokud");
  io.files["/home/neil/.kairoku/config.json"] = JSON.stringify({
    listen: { host: "127.0.0.1", port: 7801 },
  });
  io.files["/home/neil/.kairoku/token.env"] = "KAIROKU_DAEMON_TOKEN=legacy-token\n";
  io.files["/home/neil/.config/systemd/user/kairoku-daemon.service"] = "[Unit]\n";
  io.modes["/home/neil/.kairoku"] = 0o700;
  io.files["/home/neil/.kairoku/drain.token"] = `${"a".repeat(64)}\n`;
  io.modes["/home/neil/.kairoku/drain.token"] = 0o600;
  io.canned["/usr/bin/kairokud status --json"] = {
    stdout: JSON.stringify({
      installationId: "inst-rust-1",
      dataRoot: installation.dataRoot,
      daemonId: "daemon-rust-1",
      ownerId: "owner-rust-1",
      processInstanceId: "process-rust-1",
      backendUrl: "https://app.kairoku.dev",
      heartbeatOk: true,
      service: { running: true },
    }),
  };
  io.canned["/usr/bin/kairokud call system.recoveryDecide --params"] = {
    stdout: JSON.stringify({
      released: true,
      operationId: "migration-inst-rust-1",
      purpose: "migration",
      previousRevision: 2,
      appliedRevision: 3,
      claimsInhibited: false,
    }),
  };
  const activeRuns = opts.activeRuns ?? 1;
  io.fetch = async (url, init) => {
    if (url === "http://127.0.0.1:7801/drain" && init?.method === "POST") {
      return Response.json({
        local: "draining",
        cloud: "pending",
        activeAttempts: activeRuns,
        pendingReports: 0,
        claimsInFlight: 0,
      });
    }
    if (url === "http://127.0.0.1:7801/status") {
      if (opts.statusOk === false) return new Response("down", { status: 503 });
      if (opts.statusBody !== undefined) return Response.json(opts.statusBody);
      return Response.json({
        version: "0.1.0",
        capacity: { running: activeRuns, max: 2 },
        runs: activeRuns > 0 ? [{ runId: "r-live", status: "running" }] : [],
        link: { linked: true, pendingReports: 0, claimsInFlight: 0 },
      });
    }
    return new Response("", { status: 404 });
  };
  return io;
}

describe("runMigration", () => {
  test("an active legacy run blocks before disable without kill/bootout", async () => {
    const io = fixture();
    const result: MigrationResult = await runMigration(io, installation);
    expect(result.state).toBe("blocked");
    expect(result.blockers).toContain("legacy_active_run");
    expect(io.calls.flat().join(" ")).not.toContain("kill");
    expect(io.calls.some((c) => c.includes("bootout") || c.includes("disable"))).toBe(false);
    const receipt = loadReceipt(io);
    expect(receipt?.predecessor?.label).toBe("kairoku-daemon");
    expect(receipt?.replacement?.label).toBe("io.kairoku.daemon");
  });

  test("disposition of the active run allows reconcile without cutover", async () => {
    const io = fixture();
    const result = await runMigration(io, installation, { dispositioned: ["legacy_active_run"] });
    expect(result.state).toBe("reconciled");
    expect(result.blockers).toEqual([]);
    expect(io.calls.some((c) => c.includes("bootout") || c.includes("disable"))).toBe(false);
  });

  test("repeated migration resumes from the receipt without rewriting tokens", async () => {
    const io = fixture();
    await runMigration(io, installation);
    const again = await runMigration(io, installation);
    expect(again.state).toBe("blocked");
    expect(io.files["/home/neil/.kairoku/migration-receipt.json"]).toContain("legacy_active_run");
    expect(io.files["/home/neil/.kairoku/token.env"]).toContain("legacy-token");
  });

  test("distinct Bun/Rust labels disable only the predecessor on cutover", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    const result = await runMigration(io, installation, { cutover: true });
    expect(result.state).toBe("complete");
    expect(handoffComplete(io)).toBe(true);
    const joined = io.calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("disable --now kairoku-daemon"))).toBe(true);
    expect(joined.some((c) => c.includes("disable --now io.kairoku.daemon"))).toBe(false);
    expect(joined.some((c) => c.includes("kairokud drain"))).toBe(false);
  });

  test("a post-disable retry accepts canonical nested Rust dataRoot without draining twice", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["/usr/bin/kairokud status --json"] = {
      stdout: JSON.stringify({
        installationId: installation.installationId,
        daemonId: "daemon-rust-1",
        ownerId: "owner-rust-1",
        processInstanceId: "process-rust-1",
        backendUrl: "https://app.kairoku.dev",
        heartbeatOk: true,
        service: { running: true },
      }),
    };
    expect((await runMigration(io, installation, { cutover: true })).blockers).toEqual(["rust_identity_unknown"]);
    expect(loadReceipt(io)?.predecessorDisabled).toBe(true);
    const interrupted = loadReceipt(io)!;
    interrupted.state = "legacy_disabled";
    interrupted.blockers = [];
    io.files["/home/neil/.kairoku/migration-receipt.json"] = `${JSON.stringify(interrupted)}\n`;

    io.canned["systemctl --user is-active kairoku-daemon"] = { code: 3, stdout: "inactive\n" };
    io.canned["systemctl --user is-enabled kairoku-daemon"] = { code: 1, stdout: "disabled\n" };
    io.canned["/usr/bin/kairokud status --json"] = {
      stdout: JSON.stringify({
        installation: { dataRoot: installation.dataRoot },
        installationId: installation.installationId,
        daemonId: "daemon-rust-1",
        ownerId: "owner-rust-1",
        processInstanceId: "process-rust-1",
        backendUrl: "https://app.kairoku.dev",
        heartbeatOk: true,
        service: { running: true },
      }),
    };
    const disableCallsBeforeRetry = io.calls.filter((call) =>
      call.join(" ").includes("disable --now kairoku-daemon"),
    ).length;
    const retry = await runMigration(io, installation, { cutover: true });
    expect(retry).toEqual({ state: "complete", blockers: [] });
    expect(io.calls.filter((call) => call.join(" ").includes("disable --now kairoku-daemon"))).toHaveLength(
      disableCallsBeforeRetry,
    );
  });

  test("conflicting top-level and nested Rust data roots are refused", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["/usr/bin/kairokud status --json"] = {
      stdout: JSON.stringify({
        installation: { dataRoot: installation.dataRoot },
        installationId: installation.installationId,
        dataRoot: "/different/root",
        daemonId: "daemon-rust-1",
        ownerId: "owner-rust-1",
        processInstanceId: "process-rust-1",
        backendUrl: "https://app.kairoku.dev",
        heartbeatOk: true,
        service: { running: true },
      }),
    };
    expect((await runMigration(io, installation, { cutover: true })).blockers).toEqual(["rust_identity_mismatch"]);
  });

  test("unreachable or malformed /status is unknown — never treated as idle", async () => {
    const unreachable = fixture({ statusOk: false });
    const a = await runMigration(unreachable, installation);
    expect(a.state).toBe("blocked");
    expect(a.blockers).toContain("legacy_status_http");

    const malformed = fixture({ statusBody: { capacity: {}, link: {} } });
    const b = await runMigration(malformed, installation);
    expect(b.state).toBe("blocked");
    expect(b.blockers).toContain("legacy_status_counters_unknown");
  });

  test("a fresh successful probe clears a stored transient observation", async () => {
    const io = fixture({ statusBody: { capacity: {}, link: {} } });
    const first = await runMigration(io, installation);
    expect(first.blockers).toEqual(["legacy_status_counters_unknown"]);

    io.fetch = async (url, init) => {
      if (url === "http://127.0.0.1:7801/drain" && init?.method === "POST") {
        return Response.json({ local: "draining", claimsInFlight: 0 });
      }
      if (url === "http://127.0.0.1:7801/status") {
        return Response.json({
          capacity: { running: 0 },
          runs: [],
          link: { pendingReports: 0, claimsInFlight: 0 },
        });
      }
      return new Response("", { status: 404 });
    };

    const retry = await runMigration(io, installation, { cutover: true });
    expect(retry).toEqual({ state: "complete", blockers: [] });
    expect(loadReceipt(io)?.unresolved).toEqual([]);
  });

  test("refreshing transient observations preserves an unknown durable receipt entry", async () => {
    const io = fixture({ statusBody: { capacity: {}, link: {} } });
    await runMigration(io, installation);
    const receipt = loadReceipt(io)!;
    receipt.unresolved.push("future_durable_evidence");
    io.files["/home/neil/.kairoku/migration-receipt.json"] = `${JSON.stringify(receipt)}\n`;
    io.fetch = async (url, init) => {
      if (url === "http://127.0.0.1:7801/drain" && init?.method === "POST") {
        return Response.json({ local: "draining", claimsInFlight: 0 });
      }
      if (url === "http://127.0.0.1:7801/status") {
        return Response.json({
          capacity: { running: 0 },
          runs: [],
          link: { pendingReports: 0, claimsInFlight: 0 },
        });
      }
      return new Response("", { status: 404 });
    };

    const retry = await runMigration(io, installation);
    expect(retry.blockers).toEqual(["future_durable_evidence"]);
    expect(loadReceipt(io)?.unresolved).toEqual(["future_durable_evidence"]);
  });

  test("blanket disposition of a counter name does not clear unknown inventory", async () => {
    const io = fixture({ statusOk: false });
    const result = await runMigration(io, installation, {
      dispositioned: ["legacy_active_run", "legacy_pending_report", "all"],
    });
    expect(result.state).toBe("blocked");
    expect(result.blockers).toContain("legacy_status_http");
  });

  test("unreadable predecessor inventory blocks", async () => {
    const io = fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } });
    io.bins.add("kairokud");
    io.files["/home/neil/.kairoku/config.json"] = "{not-json";
    expect(inventoryPredecessor(io)).toBe("unknown");
    const result = await runMigration(io, installation);
    expect(result.state).toBe("blocked");
    expect(result.blockers).toContain("predecessor_inventory_unknown");
  });

  test("fresh install with no predecessor completes without disable", async () => {
    const io = fakeIo({ platform: "linux", home: "/home/neil", env: { USER: "neil" } });
    io.bins.add("kairokud");
    const result = await runMigration(io, installation);
    expect(result.state).toBe("complete");
    expect(io.calls.some((c) => c.includes("disable") || c.includes("bootout"))).toBe(false);
  });

  test("cutover latches then releases matching migration inhibition", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    await runMigration(io, installation, { cutover: true });
    const release = io.calls.find((call) => call.includes("system.recoveryDecide"));
    expect(release).toBeDefined();
    expect(JSON.parse(release![release!.indexOf("--params") + 1]!)).toEqual({
      action: "releaseMaintenance",
      operationId: "migration-inst-rust-1",
      purpose: "migration",
      expectedRevision: 2,
    });
  });

  test("missing replacement identity blocks before authoritative release", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    io.canned["/usr/bin/kairokud status --json"] = {
      stdout: JSON.stringify({ installationId: installation.installationId, service: { running: true } }),
    };

    const result = await runMigration(io, installation, { cutover: true });

    expect(result).toEqual({ state: "blocked", blockers: ["rust_identity_unknown"] });
    expect(io.calls.some((call) => call.includes("system.recoveryDecide"))).toBe(false);
  });

  test("failed authoritative release cannot produce a complete receipt", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    io.canned["/usr/bin/kairokud call system.recoveryDecide --params"] = {
      code: 1,
      stderr: "revision conflict",
    };

    const result = await runMigration(io, installation, { cutover: true });

    expect(result).toEqual({ state: "blocked", blockers: ["replacement_release_failed"] });
    expect(handoffComplete(io)).toBe(false);
  });

  test("foreign or ineffective release result cannot produce complete", async () => {
    const io = fixture({ activeRuns: 0 });
    io.canned["systemctl --user disable --now kairoku-daemon"] = { code: 0 };
    io.canned["/usr/bin/kairokud call system.recoveryDecide --params"] = {
      stdout: JSON.stringify({
        released: true,
        operationId: "foreign-operation",
        purpose: "migration",
        previousRevision: 2,
        appliedRevision: 3,
        claimsInhibited: false,
      }),
    };

    const result = await runMigration(io, installation, { cutover: true });

    expect(result).toEqual({ state: "blocked", blockers: ["replacement_release_unverified"] });
    expect(handoffComplete(io)).toBe(false);
  });
});
