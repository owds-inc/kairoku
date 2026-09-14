import { describe, expect, test } from "bun:test";
import { runMigration, type MigrationResult } from "./migration";
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

function fixture(): FakeIo {
  const io = fakeIo({ platform: "linux", home: "/home/neil", uid: 1000, env: { USER: "neil" } });
  io.bins.add("kairokud");
  io.files["/home/neil/.kairoku/config.json"] = JSON.stringify({
    listen: { host: "127.0.0.1", port: 7801 },
  });
  io.canned["/usr/bin/kairokud drain --json"] = {
    stdout: JSON.stringify({ local: "draining", cloud: "pending", activeAttempts: 0, pendingReports: 0 }),
  };
  // Active legacy run — cutover must block without disable/kill.
  io.fetch = async (url) => {
    if (url === "http://127.0.0.1:7801/status") {
      return Response.json({
        version: "0.1.0",
        capacity: { running: 1, max: 2 },
        runs: [{ runId: "r-live", status: "running" }],
        link: { linked: true, pendingReports: 0 },
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
    expect(io.files["/home/neil/.kairoku/token.env"]).toBeUndefined();
  });
});
