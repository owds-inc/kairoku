/**
 * Everything a command touches outside its own arguments — the terminal, the
 * shell, the filesystem, the network — behind one object, so every command is
 * unit-testable with the fake in testkit.ts. Same injection pattern as the
 * daemon's WorktreeOps.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

export type ShellResult = { code: number; stdout: string; stderr: string };

export type Io = {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  uid: number;
  execPath: string;
  env: Record<string, string | undefined>;
  /** One line to stdout / stderr. */
  out(text: string): void;
  err(text: string): void;
  /** A readline prompt; the answer, trimmed. */
  ask(question: string): Promise<string>;
  which(bin: string): string | null;
  /** Run argv. `live` streams stdio to the terminal instead of capturing it. */
  shell(argv: string[], opts?: { live?: boolean; env?: Record<string, string> }): Promise<ShellResult>;
  exists(path: string): boolean;
  /** File text, or null when unreadable. */
  readFile(path: string): string | null;
  /** Permission bits (e.g. 0o600), or null when absent. */
  mode(path: string): number | null;
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

export const io: Io = {
  platform: process.platform,
  arch: process.arch,
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  execPath: process.execPath,
  env: process.env,
  out: (text) => void process.stdout.write(text + "\n"),
  err: (text) => void process.stderr.write(text + "\n"),
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
  which: (bin) => Bun.which(bin),
  async shell(argv, opts = {}) {
    const proc = Bun.spawn(argv, {
      stdin: opts.live ? "inherit" : "ignore",
      stdout: opts.live ? "inherit" : "pipe",
      stderr: opts.live ? "inherit" : "pipe",
      env: { ...process.env, ...opts.env },
    });
    const text = (s: unknown) => (s instanceof ReadableStream ? new Response(s).text() : "");
    const [code, stdout, stderr] = await Promise.all([proc.exited, text(proc.stdout), text(proc.stderr)]);
    return { code, stdout, stderr };
  },
  exists: existsSync,
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  mode(path) {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
  fetch: (url, init) => globalThis.fetch(url, init),
};
