import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  ensureRunDir,
  eventsPath,
  runDir,
  stdoutPath,
} from "./events";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "hikyaku-events-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort — the dir may already be gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("events (RF-003)", () => {
  test("paths sit under <runsDir>/<runId>/", () => {
    expect(runDir("/runs", "abc")).toBe("/runs/abc");
    expect(eventsPath("/runs", "abc")).toBe("/runs/abc/events.jsonl");
    expect(stdoutPath("/runs", "abc")).toBe("/runs/abc/stdout.log");
  });

  test("appends one JSON object per line, each stamped", () => {
    const runs = tmp();
    ensureRunDir(runs, "r1");
    appendEvent(runs, "r1", "created", { role: "executor" });
    appendEvent(runs, "r1", "started", { pid: 42 });
    appendEvent(runs, "r1", "finished", { status: "idle" });

    const lines = readFileSync(eventsPath(runs, "r1"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.type)).toEqual(["created", "started", "finished"]);
    expect(parsed[0].role).toBe("executor");
    expect(parsed[1].pid).toBe(42);
    for (const event of parsed) {
      expect(Date.parse(event.ts)).not.toBeNaN();
    }
  });

  test("undefined fields are dropped rather than written as null", () => {
    const runs = tmp();
    ensureRunDir(runs, "r2");
    appendEvent(runs, "r2", "created", { model: undefined, role: "executor" });
    const event = JSON.parse(readFileSync(eventsPath(runs, "r2"), "utf8").trim());
    expect(event).not.toHaveProperty("model");
    expect(event.role).toBe("executor");
  });

  test("ensureRunDir is idempotent", () => {
    const runs = tmp();
    expect(ensureRunDir(runs, "r3")).toBe(join(runs, "r3"));
    expect(ensureRunDir(runs, "r3")).toBe(join(runs, "r3"));
    expect(existsSync(join(runs, "r3"))).toBe(true);
  });

  test("a log write that fails never breaks the run it is describing", () => {
    // The event log is diagnostics. A full or unwritable disk must not take a
    // supervised agent down with it.
    const runs = tmp();
    expect(() =>
      appendEvent(runs, "never-created", "error", { message: "x" }),
    ).not.toThrow();
  });
});
