/**
 * A fake Io for the CLI tests: an in-memory filesystem, canned shell answers
 * keyed by the argv prefix, scripted prompt answers, and a record of every
 * shell call and every line printed.
 */

import type { Io, ShellResult } from "./io";

type Canned = Partial<ShellResult> | ((argv: string[]) => Partial<ShellResult>);

export type FakeIo = Io & {
  /** Every shell invocation, in order. */
  calls: string[][];
  lines: string[];
  errors: string[];
  /** Scripted answers to `ask`, consumed in order. */
  answers: string[];
  questions: string[];
  files: Record<string, string>;
  modes: Record<string, number>;
  /** Binaries `which` finds. */
  bins: Set<string>;
  /** Canned shell results keyed by a space-joined argv prefix; first match wins. */
  canned: Record<string, Canned>;
};

export function fakeIo(overrides: Partial<FakeIo> = {}): FakeIo {
  const fake: FakeIo = {
    platform: "darwin",
    arch: "arm64",
    home: "/home/tester",
    uid: 501,
    execPath: "/usr/local/bin/kairoku",
    env: {},
    calls: [],
    lines: [],
    errors: [],
    answers: [],
    questions: [],
    files: {},
    modes: {},
    bins: new Set(),
    canned: {},
    out: (text) => void fake.lines.push(...text.split("\n")),
    err: (text) => void fake.errors.push(...text.split("\n")),
    async ask(question) {
      fake.questions.push(question);
      if (fake.answers.length === 0) throw new Error(`unscripted prompt: ${question}`);
      return fake.answers.shift()!;
    },
    which: (bin) => (fake.bins.has(bin) ? `/usr/bin/${bin}` : null),
    async shell(argv) {
      fake.calls.push(argv);
      const line = argv.join(" ");
      const key = Object.keys(fake.canned).find((k) => line === k || line.startsWith(k + " "));
      const hit = key === undefined ? {} : fake.canned[key]!;
      return { code: 0, stdout: "", stderr: "", ...(typeof hit === "function" ? hit(argv) : hit) };
    },
    exists: (path) => path in fake.files,
    readFile: (path) => fake.files[path] ?? null,
    mode: (path) => fake.modes[path] ?? (path in fake.files ? 0o644 : null),
    fetch: () => Promise.reject(new Error("unscripted fetch")),
    ...overrides,
  };
  return fake;
}
