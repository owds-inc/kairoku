import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  ensureRunDir,
  EventBuffer,
  EVENT_TEXT_MAX,
  EVENTS_PER_REPORT_MAX,
  eventsPath,
  runDir,
  stdoutPath,
  resultText,
  type EventKind,
} from "./events";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-events-"));
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
    expect(eventsPath("/runs", "abc", "r1")).toBe("/runs/abc/r1.jsonl");
    expect(stdoutPath("/runs", "abc", "r1")).toBe("/runs/abc/r1.log");
  });

  test("appends one JSON object per line, each stamped", () => {
    const runs = tmp();
    ensureRunDir(runs, "r1");
    appendEvent(runs, "r1", "r1", "created", { role: "implementer" });
    appendEvent(runs, "r1", "r1", "started", { pid: 42 });
    appendEvent(runs, "r1", "r1", "finished", { status: "idle" });

    const lines = readFileSync(eventsPath(runs, "r1", "r1"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.type)).toEqual(["created", "started", "finished"]);
    expect(parsed[0].role).toBe("implementer");
    expect(parsed[1].pid).toBe(42);
    for (const event of parsed) {
      expect(Date.parse(event.ts)).not.toBeNaN();
    }
  });

  test("undefined fields are dropped rather than written as null", () => {
    const runs = tmp();
    ensureRunDir(runs, "r2");
    appendEvent(runs, "r2", "r2", "created", { model: undefined, role: "implementer" });
    const event = JSON.parse(readFileSync(eventsPath(runs, "r2", "r2"), "utf8").trim());
    expect(event).not.toHaveProperty("model");
    expect(event.role).toBe("implementer");
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
      appendEvent(runs, "never-created", "r", "error", { message: "x" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// O-3: the curated channel (§20 item 7). The JSONL above stays the local truth;
// these are the ≤ 2 KB lines that ride the heartbeat.

describe("events — curation, masking and the bounded buffer", () => {
  test("a text line is truncated to 2 KB and says it was", () => {
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d1", runId: "r1" });
    buffer.push("text", "x".repeat(5_000));
    const [event] = buffer.drain();
    expect(event!.text.length).toBeLessThanOrEqual(EVENT_TEXT_MAX);
    expect(event!.text.endsWith("…")).toBe(true);
  });

  test("every delivered value is masked, in the buffer AND on disk", () => {
    const runs = tmp();
    const buffer = new EventBuffer({
      runsDir: runs,
      dispatchId: "d2",
      runId: "r2",
      secrets: ["kai_supersecret_value", "short"],
    });
    buffer.push("tool", "Bash {\"command\":\"curl -H 'auth: kai_supersecret_value'\"}");
    const [event] = buffer.drain();
    expect(event!.text).not.toContain("kai_supersecret_value");
    expect(event!.text).toContain("••••");
    expect(readFileSync(eventsPath(runs, "d2", "r2"), "utf8")).not.toContain("kai_supersecret_value");
  });

  test("a secret too short to be distinctive is not used as a mask pattern", () => {
    // Masking every occurrence of "short" would redact ordinary prose and make
    // the log useless; a credential worth masking is long.
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d3", runId: "r3", secrets: ["abc"] });
    buffer.push("text", "the abc of it");
    expect(buffer.drain()[0]!.text).toBe("the abc of it");
  });

  test("seq counts from zero, in order, and every line is stamped", () => {
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d4", runId: "r4" });
    buffer.push("text", "one");
    buffer.push("ok", "two");
    const events = buffer.drain();
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events.map((e) => e.kind)).toEqual(["text", "ok"]);
    for (const event of events) expect(Date.parse(event.ts)).not.toBeNaN();
  });

  test("EVERY delivered batch is seq-ordered, the one that follows a drop included", () => {
    // The notice is minted at DROP time, so it carries the seq of the line it
    // stands in for and leads the survivors. A notice numbered at drain time
    // would sort AFTER every line it precedes, and the app renders by seq.
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d4b", runId: "r4b" });
    for (let i = 0; i < 60; i++) buffer.push("text", `line ${i}`);

    const first = buffer.drain();
    expect(first[0]!.kind).toBe("error");
    expect(first.map((e) => e.seq)).toEqual([...first.map((e) => e.seq)].sort((a, b) => a - b));
    // Strictly increasing, and the notice stands where the first dropped line did.
    expect(first[0]!.seq).toBe(0);
    expect(first[0]!.seq).toBeLessThan(first[1]!.seq);

    buffer.push("text", "after");
    const second = buffer.drain();
    expect(second.map((e) => e.seq)).toEqual([...second.map((e) => e.seq)].sort((a, b) => a - b));
    expect(second[0]!.seq).toBeGreaterThan(first.at(-1)!.seq);
  });

  test("drain empties the pending buffer without touching the file", () => {
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d5", runId: "r5" });
    buffer.push("text", "one");
    expect(buffer.drain()).toHaveLength(1);
    expect(buffer.drain()).toHaveLength(0);
    expect(buffer.pending()).toBe(0);
    expect(readFileSync(eventsPath(runs, "d5", "r5"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("the buffer is bounded at 50: the oldest go, and one line says how many", () => {
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d6", runId: "r6" });
    for (let i = 0; i < 60; i++) buffer.push("text", `line ${i}`);
    expect(buffer.pending()).toBe(EVENTS_PER_REPORT_MAX);

    const events = buffer.drain();
    expect(events).toHaveLength(EVENTS_PER_REPORT_MAX);
    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.text).toContain("10");
    expect(events[0]!.text).toContain("dropped");
    // The oldest are what went. The one the notice displaced is not lost: it
    // leads the next beat.
    expect(events.at(-1)!.text).toBe("line 58");
    expect(events.some((e) => e.text === "line 0")).toBe(false);
    expect(buffer.drain()).toEqual([expect.objectContaining({ text: "line 59" })]);
    // Nothing is dropped from the local log — that is why it exists.
    expect(readFileSync(eventsPath(runs, "d6", "r6"), "utf8").split("\n").filter(Boolean)).toHaveLength(60);
  });

  test("the overflow notice is reported once, not on every later drain", () => {
    const runs = tmp();
    const buffer = new EventBuffer({ runsDir: runs, dispatchId: "d7", runId: "r7" });
    for (let i = 0; i < 55; i++) buffer.push("text", `line ${i}`);
    expect(buffer.drain()[0]!.kind).toBe("error");
    buffer.drain();
    buffer.push("text", "after");
    expect(buffer.drain()).toEqual([expect.objectContaining({ text: "after", kind: "text" })]);
  });

  test("an unwritable log still yields curated events — the wire is not the disk", () => {
    const buffer = new EventBuffer({ runsDir: "/nowhere/at/all", dispatchId: "d8", runId: "r8" });
    expect(() => buffer.push("text", "one")).not.toThrow();
    expect(buffer.drain()).toHaveLength(1);
  });
});

/**
 * §23.4 — the transcript's three kinds. The vocabulary is the APP's, vendored,
 * and the ORDER is part of the contract: the app's `dispatch_events.kind` is a
 * pg enum, whose values are positional in every dump, so the three are appended
 * after the v1 five and never inserted among them.
 */
describe("events — §23.4's result, phase and index kinds", () => {
  test("the vocabulary is the app's eight words, appended in the app's order", () => {
    const kinds: EventKind[] = ["text", "tool", "ok", "deny", "error", "result", "phase", "index"];
    const dir = tmp();
    const buffer = new EventBuffer({ runsDir: dir, dispatchId: "d1", runId: "r1" });
    for (const kind of kinds) buffer.push(kind, kind);
    expect(buffer.drain().map((e) => e.kind)).toEqual(kinds);
  });

  test("a result line is `ok|error <ms>ms <first non-empty output line>` — the shape the app folds", () => {
    expect(resultText(true, 1832, "hello\nworld")).toBe("ok 1832ms hello");
    expect(resultText(false, 12, "\n\n  boom: exit 1\nstack…")).toBe("error 12ms boom: exit 1");
  });

  test("a result with no output is still a whole line, and a duration is never fractional", () => {
    expect(resultText(true, 4.7, "   \n  ")).toBe("ok 5ms");
    expect(resultText(true, -1, "")).toBe("ok 0ms");
  });

  test("an unknown duration is left out rather than guessed at as zero", () => {
    expect(resultText(true, null, "done")).toBe("ok done");
  });

  test("a result and a phase are masked and truncated like every other kind", () => {
    const dir = tmp();
    const buffer = new EventBuffer({ runsDir: dir, dispatchId: "d1", runId: "r1", secrets: ["kai_run_token_1"] });
    buffer.push("result", resultText(false, 3, "curl failed with kai_run_token_1"));
    buffer.push("phase", "reviewing");
    const drained = buffer.drain();
    expect(drained[0]!.text).toBe("error 3ms curl failed with ••••");
    expect(drained[1]).toMatchObject({ kind: "phase", text: "reviewing" });
  });

  test("EVENTS_PER_REPORT_MAX still bounds a flush that is all results", () => {
    const dir = tmp();
    const buffer = new EventBuffer({ runsDir: dir, dispatchId: "d1", runId: "r1" });
    for (let i = 0; i < EVENTS_PER_REPORT_MAX + 10; i++) buffer.push("result", resultText(true, i, `line ${i}`));
    const drained = buffer.drain();
    expect(drained.length).toBe(EVENTS_PER_REPORT_MAX);
    expect(drained[0]!.kind).toBe("error");
    expect(drained[0]!.text).toContain("10 earlier event lines were dropped");
  });
});
