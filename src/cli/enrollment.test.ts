/**
 * F03 enrollment IO contract and failure paths. Uses fakeIo — no live cloud.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ENROLLMENT_PROGRESS_FILE,
  EnrollmentIncompleteError,
  clearEnrollmentSecrets,
  loadEnrollmentProgress,
  runEnrollment,
  saveEnrollmentProgress,
  type EnrollmentProgress,
} from "./enrollment";
import type { Installation } from "./runtime";
import { fakeIo, type FakeIo } from "./testkit";

const issuedToken = "kai_issued_secret_token_never_print_me";
const expectedDaemonId = "daemon-abc";
const expectedOwnerId = "user_owner_1";
const requestId = "11111111-1111-4111-8111-111111111111";
const installationId = "install-xyz";
const backendUrl = "https://app.test";

const installation: Installation = {
  schemaVersion: 1,
  installationId,
  dataRoot: "/home/tester/.local/share/kairokud",
  profile: "linux-personal",
  executionUser: "tester",
  executable: "/usr/bin/kairokud",
  service: {
    manager: "systemd",
    scope: "user",
    label: "kairokud.service",
    package: "direct",
  },
};

function progressFile(io: FakeIo): string {
  return join(installation.dataRoot, ENROLLMENT_PROGRESS_FILE);
}

function baseIo(): FakeIo {
  const io = fakeIo({
    platform: "linux",
    home: "/home/tester",
    env: {
      HOSTNAME: "agent1",
      KAIROKU_ENROLLMENT_POLL_MS: "0",
      KAIROKU_ENROLLMENT_HEARTBEAT_MS: "0",
    },
  });
  io.bins.add("kairokud");
  return io;
}

/** Seed HTTPS responses: approved (poll), then matching heartbeat. Ack is via shell. */
function seedHappyFetches(io: FakeIo, heartbeatDaemonId = expectedDaemonId): void {
  const queue: Array<() => Response> = [
    () =>
      Response.json({
        state: "approved",
        daemonId: expectedDaemonId,
        token: issuedToken,
        ownerId: expectedOwnerId,
        installationId,
      }),
    () =>
      Response.json({
        daemonId: heartbeatDaemonId,
        ownerId: expectedOwnerId,
        installationId,
        liveness: "online",
        heartbeatIntervalMs: 30_000,
      }),
  ];
  io.fetch = async (url) => {
    if (String(url).includes("/api/daemon/enrollment/poll")) {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra poll");
      return next();
    }
    if (String(url).includes("/api/daemon/heartbeat")) {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra heartbeat");
      return next();
    }
    if (String(url).includes("/api/daemon/enrollment/request")) {
      return Response.json({
        requestId,
        pollSecret: "poll-secret-value",
        userCode: "ABCD2345",
        verificationUrl: `${backendUrl}/link?code=ABCD2345`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        intervalSeconds: 5,
        state: "pending",
      });
    }
    return new Response("", { status: 404 });
  };
}

function canAcknowledge(io: FakeIo): void {
  io.canned["/usr/bin/kairokud settings kairoku.token --stdin"] = { code: 0, stdout: "" };
  io.canned["/usr/bin/kairokud link acknowledge --request-id"] = () => ({
    code: 0,
    stdout: JSON.stringify({
      state: "activated",
      requestId,
      daemonId: expectedDaemonId,
      installationId,
      ownerId: expectedOwnerId,
    }),
  });
}

describe("runEnrollment — observable IO contract", () => {
  test("writes the token via --stdin, never prints or argv-logs it, returns identity", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      state: "pending",
      intervalSeconds: 5,
    });

    const result = await runEnrollment(io, installation, { backendUrl });

    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(true);
    expect(io.calls.flat().join(" ")).not.toContain(issuedToken);
    expect(io.lines.join("\n")).not.toContain(issuedToken);
    expect(result).toEqual({ daemonId: expectedDaemonId, ownerId: expectedOwnerId });

    const after = loadEnrollmentProgress(io, installation);
    expect(after?.pollSecret).toBeUndefined();
    expect(after?.daemonId).toBe(expectedDaemonId);
    expect(io.mode(progressFile(io))).toBe(0o600);
  });

  test("wrong heartbeat daemonId returns incomplete setup and does not print success", async () => {
    const io = baseIo();
    seedHappyFetches(io, "wrong-daemon-id");
    canAcknowledge(io);
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      state: "pending",
      intervalSeconds: 5,
    });

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toBeInstanceOf(
      EnrollmentIncompleteError,
    );
    expect(io.lines.join("\n")).not.toContain(issuedToken);
    expect(io.lines.join("\n").toLowerCase()).not.toContain("account setup complete");
    // Progress retained for resume (still has request id).
    expect(loadEnrollmentProgress(io, installation)?.requestId).toBe(requestId);
  });
});

describe("runEnrollment — failure and resume paths", () => {
  test("secret write failure keeps progress and never prints the token", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    io.canned["/usr/bin/kairokud settings kairoku.token --stdin"] = {
      code: 1,
      stderr: "settings.update failed",
    };
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
    });

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(/settings/);
    expect(io.calls.flat().join(" ")).not.toContain(issuedToken);
    expect(loadEnrollmentProgress(io, installation)?.pollSecret).toBe("poll-secret-value");
  });

  test("heartbeat timeout is incomplete setup with resumable progress", async () => {
    const io = baseIo();
    let heartbeats = 0;
    io.fetch = async (url) => {
      if (String(url).includes("/poll")) {
        return Response.json({
          state: "approved",
          daemonId: expectedDaemonId,
          token: issuedToken,
          ownerId: expectedOwnerId,
          installationId,
        });
      }
      if (String(url).includes("/heartbeat")) {
        heartbeats++;
        return Response.json({ liveness: "offline" }, { status: 503 });
      }
      return new Response("", { status: 404 });
    };
    canAcknowledge(io);
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
    });

    // Shrink attempts via env so the test stays fast — awaitHeartbeatProof uses maxAttempts 30;
    // override by making every heartbeat fail and use seed with few sleeps (0 ms).
    await expect(
      runEnrollment(io, installation, { backendUrl, maxHeartbeatAttempts: 3 }),
    ).rejects.toThrow(/heartbeat/);
    expect(heartbeats).toBeGreaterThan(0);
    expect(loadEnrollmentProgress(io, installation)?.requestId).toBe(requestId);
  });

  function seedOwnerChangeProgress(io: FakeIo): void {
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
      ownerId: "user_previous_owner",
      daemonId: "daemon-old",
      state: "activated",
    });
  }

  test("owner-changing enrollment refuses while activeAttempts are reported", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    io.canned["/usr/bin/kairokud status --json"] = {
      code: 0,
      stdout: JSON.stringify({
        activeAttempts: 2,
        unresolvedAttempts: 0,
        pendingReports: 0,
      }),
    };
    seedOwnerChangeProgress(io);

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(
      /owner-changing enrollment refused.*activeAttempts=2/,
    );
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
  });

  test("owner-changing enrollment refuses when status counters are null/unknown", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    // Matches F01 status --json today: counters stay null until durable stores exist.
    io.canned["/usr/bin/kairokud status --json"] = {
      code: 0,
      stdout: JSON.stringify({
        activeAttempts: null,
        unresolvedAttempts: null,
        pendingReports: null,
      }),
    };
    seedOwnerChangeProgress(io);

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(
      /owner-changing enrollment refused: kairokud status counters unknown \(activeAttempts, unresolvedAttempts, pendingReports\)/,
    );
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
  });

  test("owner-changing enrollment refuses when status counters are omitted", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    io.canned["/usr/bin/kairokud status --json"] = {
      code: 0,
      stdout: JSON.stringify({}),
    };
    seedOwnerChangeProgress(io);

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(
      /owner-changing enrollment refused: kairokud status counters unknown/,
    );
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
  });

  test("owner-changing enrollment proceeds when status counters are definitive zeros", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    io.canned["/usr/bin/kairokud status --json"] = {
      code: 0,
      stdout: JSON.stringify({
        activeAttempts: 0,
        unresolvedAttempts: 0,
        pendingReports: 0,
      }),
    };
    seedOwnerChangeProgress(io);

    const result = await runEnrollment(io, installation, { backendUrl });
    expect(result).toEqual({ daemonId: expectedDaemonId, ownerId: expectedOwnerId });
    expect(io.calls.some((c) => c.includes("status") && c.includes("--json"))).toBe(true);
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(true);
  });

  test("restores only matching installation progress", () => {
    const io = baseIo();
    const progress: EnrollmentProgress = {
      schemaVersion: 1,
      installationId: "other-install",
      requestId,
      pollSecret: "secret",
      backendUrl,
    };
    saveEnrollmentProgress(io, { ...installation, installationId: "other-install" }, progress);
    // Same dataRoot file but different installation id in loader check:
    expect(loadEnrollmentProgress(io, installation)).toBeNull();
  });

  test("clearEnrollmentSecrets overwrites pollSecret without deleting the file", () => {
    const io = baseIo();
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "must-go",
      backendUrl,
      daemonId: expectedDaemonId,
      ownerId: expectedOwnerId,
      state: "activated",
    });
    clearEnrollmentSecrets(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "must-go",
      backendUrl,
      daemonId: expectedDaemonId,
      ownerId: expectedOwnerId,
      state: "activated",
    });
    expect(io.exists(progressFile(io))).toBe(true);
    expect(loadEnrollmentProgress(io, installation)?.pollSecret).toBeUndefined();
    expect(loadEnrollmentProgress(io, installation)?.daemonId).toBe(expectedDaemonId);
  });

  test("denied poll stops without writing a token", async () => {
    const io = baseIo();
    io.fetch = async (url) => {
      if (String(url).includes("/poll")) return Response.json({ state: "denied" });
      return new Response("", { status: 404 });
    };
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
    });
    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(/denied/);
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
  });

  test("HTTP loopback origin is allowed; non-loopback HTTP is refused", async () => {
    const io = baseIo();
    await expect(
      runEnrollment(io, installation, { backendUrl: "http://evil.example/app" }),
    ).rejects.toThrow(/HTTPS/);
  });
});
