/**
 * Everything a command touches outside its own arguments — the terminal, the
 * shell, the filesystem, the network — behind one object, so every command is
 * unit-testable with the fake in testkit.ts. Same injection pattern as the
 * daemon's WorktreeOps.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /** Create or replace a file; `mode` is applied either way. */
  writeFile(path: string, data: Uint8Array | string, mode?: number): void;
  rename(from: string, to: string): void;
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
  which: (bin) => Bun.which(bin, { PATH: process.env.PATH }),
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
  writeFile(path, data, mode) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    if (mode !== undefined) chmodSync(path, mode);
  },
  rename: renameSync,
  fetch: (url, init) => globalThis.fetch(url, init),
};

/** First line of `<bin> --version`, or null when the binary is not on PATH. */
export async function version(io: Io, bin: string): Promise<string | null> {
  if (!io.which(bin)) return null;
  const r = await io.shell([bin, "--version"]);
  return r.stdout.split("\n")[0]?.trim() ?? "";
}
