/**
 * install.sh against a local release: a Bun.serve stands in for GitHub,
 * serving a fake asset and checksums.txt.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "install.sh");
const os = process.platform;
const arch = process.arch;
const asset = `kairoku-${os}-${arch}`;
const FAKE_BINARY = "#!/bin/sh\necho kairoku 0.0.0-test\n";
const sha256 = createHash("sha256").update(FAKE_BINARY).digest("hex");

let checksums = `${sha256}  ${asset}\n`;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === `/${asset}`) return new Response(FAKE_BINARY);
    if (path === "/checksums.txt") return new Response(checksums);
    return new Response("", { status: 404 });
  },
});
const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function install() {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-install-"));
  dirs.push(dir);
  const proc = Bun.spawn(["sh", script], {
    env: { ...process.env, KAIROKU_RELEASE_URL: `http://127.0.0.1:${server.port}`, KAIROKU_INSTALL_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, bin: join(dir, "kairoku") };
}

describe("install.sh", () => {
  test("downloads the asset for this machine, verifies it, installs it 755 and says what is next", async () => {
    const { code, stdout, bin } = await install();
    expect(code).toBe(0);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(stdout).toContain("installed kairoku 0.0.0-test");
    expect(stdout).toContain("next: kairoku setup");
  });

  test("a checksum mismatch installs nothing and exits 1", async () => {
    checksums = `${"0".repeat(64)}  ${asset}\n`;
    try {
      const { code, stderr, bin } = await install();
      expect(code).toBe(1);
      expect(stderr).toContain("checksum mismatch");
      expect(() => statSync(bin)).toThrow();
    } finally {
      checksums = `${sha256}  ${asset}\n`;
    }
  });

  test("an asset absent from checksums.txt is refused", async () => {
    checksums = `${sha256}  kairoku-other-cpu\n`;
    try {
      const { code, stderr } = await install();
      expect(code).toBe(1);
      expect(stderr).toContain("no entry");
    } finally {
      checksums = `${sha256}  ${asset}\n`;
    }
  });
});
