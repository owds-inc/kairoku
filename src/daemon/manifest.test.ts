import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, profileOf, readManifest } from "./manifest";
import { run as exec } from "./worktree";

/** The root manifest the app repo actually carries (O-2a), verbatim in shape. */
const APP_MANIFEST = JSON.stringify({
  $comment: "How a Kairoku daemon runs this repo (DECISIONS.md §20.11).",
  setup: ["bun install"],
  env: {
    test: {
      files: [".env.local"],
      compose: "compose.test.yml",
      ports: ["PG_PORT", "PROXY_PORT"],
      inject: {
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:${PG_PORT}/main",
        NEON_PROXY_URL: "http://127.0.0.1:${PROXY_PORT}/sql",
      },
      init: ["bun run db:migrate"],
    },
  },
  check: ["bunx tsc --noEmit"],
  test: "bun test",
  concurrency: { test: 2 },
});

describe("parseManifest", () => {
  test("the app's own kairoku.json parses, $comment and all", () => {
    const result = parseManifest(APP_MANIFEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.setup).toEqual(["bun install"]);
    expect(m.check).toEqual(["bunx tsc --noEmit"]);
    expect(m.test).toBe("bun test");
    expect(m.concurrency.test).toBe(2);
    const test = m.env.test!;
    expect(test.files).toEqual([".env.local"]);
    expect(test.compose).toBe("compose.test.yml");
    expect(test.ports).toEqual(["PG_PORT", "PROXY_PORT"]);
    expect(test.init).toEqual(["bun run db:migrate"]);
    expect(test.inject.DATABASE_URL).toContain("${PG_PORT}");
  });

  test("an unknown key is IGNORED, not a failure — a strict schema would reject $comment", () => {
    const result = parseManifest(JSON.stringify({ $comment: "hi", somethingNew: 1, test: "bun test" }));
    expect(result.ok).toBe(true);
  });

  test("an empty manifest is valid and means 'nothing configured'", () => {
    const result = parseManifest("{}");
    expect(result).toEqual({
      ok: true,
      manifest: { setup: [], env: {}, check: [], concurrency: { test: 1 } },
    });
  });

  test.each([
    ["[]", "kairoku.json: the manifest must be an object"],
    ["not json", "kairoku.json: is not valid JSON"],
    [JSON.stringify({ setup: "bun install" }), "kairoku.json: setup must be an array of strings"],
    [JSON.stringify({ setup: [1] }), "kairoku.json: setup[0] must be a string"],
    [JSON.stringify({ check: [{}] }), "kairoku.json: check[0] must be a string"],
    [JSON.stringify({ test: 7 }), "kairoku.json: test must be a string"],
    [JSON.stringify({ concurrency: { test: 0 } }), "kairoku.json: concurrency.test must be a positive integer"],
    [JSON.stringify({ env: [] }), "kairoku.json: env must be an object of profiles"],
    [JSON.stringify({ env: { test: 3 } }), "kairoku.json: env.test must be an object"],
    [JSON.stringify({ env: { test: { ports: ["OK", 2] } } }), "kairoku.json: env.test.ports[1] must be a string"],
    [JSON.stringify({ env: { test: { compose: 5 } } }), "kairoku.json: env.test.compose must be a string"],
    [JSON.stringify({ env: { test: { inject: { A: 1 } } } }), "kairoku.json: env.test.inject.A must be a string"],
    [JSON.stringify({ env: { test: { init: "x" } } }), "kairoku.json: env.test.init must be an array of strings"],
  ])("an invalid manifest fails with the PATH of the error: %p", (text, error) => {
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  test("a compose path that escapes the worktree is refused — it is run with the run's own env", () => {
    const result = parseManifest(JSON.stringify({ env: { test: { compose: "../../etc/evil.yml" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("env.test.compose must stay inside the repo");
  });
});

describe("profileOf", () => {
  const manifest = parseManifest(APP_MANIFEST);

  test("names the profile the claim asked for", () => {
    expect(manifest.ok && profileOf(manifest.manifest, "test")?.compose).toBe("compose.test.yml");
  });

  test("a profile the manifest does not declare is undefined, not an invention", () => {
    expect(manifest.ok && profileOf(manifest.manifest, "staging")).toBeUndefined();
  });
});

describe("readManifest — from the COMMITTED base branch, never the worktree", () => {
  async function repo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "kairoku-manifest-"));
    await exec(["git", "init", "-q", "-b", "main"], dir);
    await exec(["git", "config", "user.email", "t@example.com"], dir);
    await exec(["git", "config", "user.name", "t"], dir);
    return dir;
  }

  async function commit(dir: string, body: string): Promise<void> {
    writeFileSync(join(dir, "kairoku.json"), body);
    await exec(["git", "add", "-A"], dir);
    await exec(["git", "commit", "-qm", "manifest"], dir);
    await exec(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], dir);
  }

  test("reads the committed file, not the one sitting in the checkout", async () => {
    const dir = await repo();
    try {
      await commit(dir, APP_MANIFEST);
      // Somebody edited the working copy. The base branch is what counts.
      writeFileSync(join(dir, "kairoku.json"), JSON.stringify({ test: "rm -rf /" }));
      const result = await readManifest(dir, "origin/main");
      expect(result?.ok).toBe(true);
      expect(result?.ok && result.manifest.test).toBe("bun test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no manifest on the branch is undefined — today's behaviour, not an error", async () => {
    const dir = await repo();
    try {
      writeFileSync(join(dir, "README.md"), "hi");
      await exec(["git", "add", "-A"], dir);
      await exec(["git", "commit", "-qm", "no manifest"], dir);
      await exec(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], dir);
      expect(await readManifest(dir, "origin/main")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a committed manifest that does not parse comes back as the failure, with its path", async () => {
    const dir = await repo();
    try {
      await commit(dir, JSON.stringify({ env: { test: { ports: [1] } } }));
      const result = await readManifest(dir, "origin/main");
      expect(result?.ok).toBe(false);
      expect(result?.ok === false && result.error).toBe("kairoku.json: env.test.ports[0] must be a string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
