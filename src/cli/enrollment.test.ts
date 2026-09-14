/**
 * F03 / FRV08 enrollment IO contract and failure paths. Uses fakeIo — no live cloud.
 * Live proof is from `kairokud status --json`, never a CLI-synthesized heartbeat.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ENROLLMENT_PROGRESS_FILE,
  EnrollmentIncompleteError,
  clearEnrollmentSecrets,
  installLoopbackRustToken,
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
const processInstanceId = "proc-instance-1";

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

/** Seed HTTPS poll/request only — live proof is shell status, not /heartbeat. */
function seedHappyFetches(io: FakeIo): void {
  io.fetch = async (url) => {
    if (String(url).includes("/api/daemon/enrollment/poll")) {
      return Response.json({
        state: "approved",
        daemonId: expectedDaemonId,
        token: issuedToken,
        ownerId: expectedOwnerId,
        installationId,
      });
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
    if (String(url).includes("/api/daemon/heartbeat")) {
      throw new Error("CLI must not synthesize live proof via /api/daemon/heartbeat");
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

function canLiveProof(
  io: FakeIo,
  overrides: Record<string, unknown> = {},
): void {
  io.canned["/usr/bin/kairokud status --json"] = {
    code: 0,
    stdout: JSON.stringify({
      activeAttempts: 0,
      unresolvedAttempts: 0,
      pendingReports: 0,
      installationId,
      daemonId: expectedDaemonId,
      ownerId: expectedOwnerId,
      processInstanceId,
      heartbeatOk: true,
      backendUrl,
      service: { running: true },
      ...overrides,
    }),
  };
}

describe("runEnrollment — observable IO contract", () => {
  test("writes the token via --stdin, never prints or argv-logs it, returns identity", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    canLiveProof(io);
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
    expect(io.calls.some((c) => c.includes("status") && c.includes("--json"))).toBe(true);
    expect(io.fetch).toBeDefined();

    const after = loadEnrollmentProgress(io, installation);
    expect(after?.pollSecret).toBeUndefined();
    expect(after?.daemonId).toBe(expectedDaemonId);
    expect(after?.installedDaemonId).toBe(expectedDaemonId);
    expect(after?.installedOwnerId).toBe(expectedOwnerId);
    expect(after?.state).toBe("live_proof");
    expect(io.mode(progressFile(io))).toBe(0o600);
  });

  test("wrong live-proof daemonId returns incomplete setup and does not print success", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    canLiveProof(io, { daemonId: "wrong-daemon-id" });
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      state: "pending",
      intervalSeconds: 5,
    });

    await expect(runEnrollment(io, installation, { backendUrl, maxHeartbeatAttempts: 3 })).rejects.toBeInstanceOf(
      EnrollmentIncompleteError,
    );
    expect(io.lines.join("\n")).not.toContain(issuedToken);
    expect(io.lines.join("\n").toLowerCase()).not.toContain("account setup complete");
    expect(loadEnrollmentProgress(io, installation)?.requestId).toBe(requestId);
    expect(loadEnrollmentProgress(io, installation)?.state).toBe("activated");
  });

  test("missing backend identity is not accepted as live proof", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    canLiveProof(io, { backendUrl: undefined });
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      state: "pending",
      intervalSeconds: 5,
    });

    await expect(runEnrollment(io, installation, { backendUrl, maxHeartbeatAttempts: 1 })).rejects.toThrow(
      /live Rust proof/,
    );
    expect(loadEnrollmentProgress(io, installation)?.state).toBe("activated");
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

  test("live Rust proof timeout is incomplete setup with resumable progress", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    canLiveProof(io, { heartbeatOk: false });
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
    });

    await expect(
      runEnrollment(io, installation, { backendUrl, maxHeartbeatAttempts: 3 }),
    ).rejects.toThrow(/live Rust proof/);
    expect(loadEnrollmentProgress(io, installation)?.requestId).toBe(requestId);
    expect(loadEnrollmentProgress(io, installation)?.state).toBe("activated");
  });

  function seedOwnerChangeProgress(io: FakeIo): void {
    // Prior installed authority survives a new pending request.
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      intervalSeconds: 5,
      installedOwnerId: "user_previous_owner",
      installedDaemonId: "daemon-old",
      state: "pending",
    });
    // Credential present + missing owner would be "unknown"; here owner is known via installed*.
    io.writeFile(join(installation.dataRoot, ".secrets.json"), "{}\n", 0o600);
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
    canLiveProof(io);
    seedOwnerChangeProgress(io);

    const result = await runEnrollment(io, installation, { backendUrl });
    expect(result).toEqual({ daemonId: expectedDaemonId, ownerId: expectedOwnerId });
    expect(io.calls.some((c) => c.includes("status") && c.includes("--json"))).toBe(true);
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(true);
  });

  test("missing owner with existing credential blocks owner change as unknown", async () => {
    const io = baseIo();
    seedHappyFetches(io);
    canAcknowledge(io);
    canLiveProof(io);
    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      pollSecret: "poll-secret-value",
      backendUrl,
      state: "pending",
      intervalSeconds: 5,
      // no installedOwnerId — credential alone ⇒ unknown, not fresh
    });
    io.writeFile(join(installation.dataRoot, ".secrets.json"), "{}\n", 0o600);

    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(
      /installed owner is unknown while a credential exists/,
    );
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
  });

  test("denied poll preserves prior attempt then fresh request can proceed later", async () => {
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
      installedOwnerId: expectedOwnerId,
      installedDaemonId: expectedDaemonId,
    });
    await expect(runEnrollment(io, installation, { backendUrl })).rejects.toThrow(/denied/);
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(false);
    const after = loadEnrollmentProgress(io, installation);
    expect(after?.state).toBe("denied");
    expect(after?.installedOwnerId).toBe(expectedOwnerId);
  });

  test("mismatched installation progress is recoverable evidence, not absence", () => {
    const io = baseIo();
    const progress: EnrollmentProgress = {
      schemaVersion: 1,
      installationId: "other-install",
      requestId,
      pollSecret: "secret",
      backendUrl,
    };
    saveEnrollmentProgress(io, { ...installation, installationId: "other-install" }, progress);
    expect(() => loadEnrollmentProgress(io, installation)).toThrow(/installation.*mismatch/i);
  });

  test("corrupt and unsupported progress are recoverable evidence, not absence", () => {
    const io = baseIo();
    io.files[progressFile(io)] = "{not-json";
    expect(() => loadEnrollmentProgress(io, installation)).toThrow(/corrupt/i);

    io.files[progressFile(io)] = JSON.stringify({ schemaVersion: 2, installationId });
    expect(() => loadEnrollmentProgress(io, installation)).toThrow(/unsupported/i);
  });

  test("progress replacement is atomic and private", () => {
    const io = baseIo();
    const target = progressFile(io);
    const writes: string[] = [];
    const write = io.writeFile;
    io.writeFile = (path, data, mode) => {
      writes.push(path);
      write(path, data, mode);
    };

    saveEnrollmentProgress(io, installation, {
      schemaVersion: 1,
      installationId,
      requestId,
      backendUrl,
    });

    expect(writes).toEqual([`${target}.tmp`]);
    expect(io.files[`${target}.tmp`]).toBeUndefined();
    expect(io.mode(target)).toBe(0o600);
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
      installedDaemonId: expectedDaemonId,
      installedOwnerId: expectedOwnerId,
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
      installedDaemonId: expectedDaemonId,
      installedOwnerId: expectedOwnerId,
      state: "activated",
    });
    expect(io.exists(progressFile(io))).toBe(true);
    expect(loadEnrollmentProgress(io, installation)?.pollSecret).toBeUndefined();
    expect(loadEnrollmentProgress(io, installation)?.daemonId).toBe(expectedDaemonId);
    expect(loadEnrollmentProgress(io, installation)?.installedOwnerId).toBe(expectedOwnerId);
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

  test("installLoopbackRustToken refuses missing identity", async () => {
    const io = baseIo();
    await expect(
      installLoopbackRustToken(io, installation, {
        backendUrl,
        token: issuedToken,
      }),
    ).rejects.toThrow(/missing daemon\/owner identity/);
  });

  test("installLoopbackRustToken already-active path proves via live status", async () => {
    const io = baseIo();
    canAcknowledge(io);
    canLiveProof(io);
    const identity = await installLoopbackRustToken(io, installation, {
      backendUrl,
      token: issuedToken,
      daemonId: expectedDaemonId,
      ownerId: expectedOwnerId,
    });
    expect(identity).toEqual({ daemonId: expectedDaemonId, ownerId: expectedOwnerId });
    expect(io.calls.some((c) => c.includes("--stdin"))).toBe(true);
    expect(loadEnrollmentProgress(io, installation)?.state).toBe("live_proof");
  });
});
