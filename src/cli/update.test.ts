import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assetName, run } from "./update";
import { fakeIo, type FakeIo } from "./testkit";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const NEW_BINARY = "#!/bin/sh\necho kairoku 0.2.0\n";

function release(tag: string, checksums = `${sha256(NEW_BINARY)}  kairoku-darwin-arm64\n`) {
  const base = `https://github.com/owds-inc/kairoku/releases/download/${tag}`;
  return {
    api: {
      tag_name: tag,
      assets: [
        { name: "kairoku-darwin-arm64", browser_download_url: `${base}/kairoku-darwin-arm64` },
        { name: "kairoku-linux-x64", browser_download_url: `${base}/kairoku-linux-x64` },
        { name: "checksums.txt", browser_download_url: `${base}/checksums.txt` },
      ],
    },
    files: {
      [`${base}/kairoku-darwin-arm64`]: NEW_BINARY,
      [`${base}/checksums.txt`]: checksums,
    },
  };
}

function machine(rel: ReturnType<typeof release> | null): FakeIo & { fetched: string[] } {
  const io = fakeIo() as FakeIo & { fetched: string[] };
  io.fetched = [];
  io.files[io.execPath] = "OLD BINARY";
  io.modes[io.execPath] = 0o755;
  io.fetch = async (url) => {
    io.fetched.push(url);
    if (rel === null) return new Response("Not Found", { status: 404 });
    if (url === "https://api.github.com/repos/owds-inc/kairoku/releases/latest") return Response.json(rel.api);
    const body = rel.files[url];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  return io;
}

describe("asset naming", () => {
  test("follows kairoku-<os>-<arch> for the four targets and nothing else", () => {
    expect(assetName("darwin", "arm64")).toBe("kairoku-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("kairoku-darwin-x64");
    expect(assetName("linux", "x64")).toBe("kairoku-linux-x64");
    expect(assetName("linux", "arm64")).toBe("kairoku-linux-arm64");
    expect(assetName("win32", "x64")).toBeNull();
    expect(assetName("linux", "ia32")).toBeNull();
  });
});

describe("kairoku update", () => {
  test("a brew install defers to brew and never fetches", async () => {
    const io = machine(release("v0.2.0"));
    io.execPath = "/opt/homebrew/Cellar/kairoku/0.1.0/bin/kairoku";
    expect(await run([], io)).toBe(0);
    expect(io.fetched).toEqual([]);
    expect(io.lines.join("\n")).toContain("brew upgrade kairoku");
  });

  test("replaces the running binary after the checksum verifies", async () => {
    const io = machine(release("v0.2.0"));
    expect(await run([], io)).toBe(0);
    expect(io.files[io.execPath]).toBe(NEW_BINARY);
    expect(io.modes[io.execPath]).toBe(0o755);
    expect(io.lines.join("\n")).toContain("0.1.0 → 0.2.0");
  });

  test("a checksum mismatch leaves the binary untouched and exits 1", async () => {
    const io = machine(release("v0.2.0", `${"0".repeat(64)}  kairoku-darwin-arm64\n`));
    expect(await run([], io)).toBe(1);
    expect(io.files[io.execPath]).toBe("OLD BINARY");
    expect(io.errors.join("\n")).toContain("checksum");
  });

  test("an asset missing from checksums.txt is refused", async () => {
    const io = machine(release("v0.2.0", `${sha256("x")}  kairoku-linux-x64\n`));
    expect(await run([], io)).toBe(1);
    expect(io.files[io.execPath]).toBe("OLD BINARY");
  });

  test("the current version is already the latest", async () => {
    const io = machine(release("v0.1.0"));
    expect(await run([], io)).toBe(0);
    expect(io.fetched).toHaveLength(1);
    expect(io.lines.join("\n")).toContain("already the latest");
  });

  test("no release reachable is an error with the status", async () => {
    const io = machine(null);
    expect(await run([], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("404");
  });

  test("an unsupported platform is refused before any fetch", async () => {
    const io = machine(release("v0.2.0"));
    io.platform = "win32";
    expect(await run([], io)).toBe(1);
    expect(io.fetched).toEqual([]);
  });
});
