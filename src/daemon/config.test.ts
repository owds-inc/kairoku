import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBindable, defaultConfigPath, loadConfig, migrateHome, DEFAULT_TIMEOUT_SEC } from "./config";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kairoku-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function warnings() {
  const lines: string[] = [];
  return { lines, warn: (line: string) => void lines.push(line) };
}

describe("config", () => {
  test("RF-006: refuses a wildcard bind", () => {
    expect(() => assertBindable("0.0.0.0")).toThrow(/RF-006/);
    expect(() => assertBindable("::")).toThrow(/RF-006/);
    expect(() => assertBindable("")).toThrow(/RF-006/);
    expect(() => assertBindable("192.168.23.167")).not.toThrow();
  });

  test("config path: KAIROKU_DAEMON_CONFIG, then HIKYAKU_CONFIG with a deprecation line, then ~/.kairoku", () => {
    const w = warnings();
    expect(defaultConfigPath({ KAIROKU_DAEMON_CONFIG: "/a.json", HIKYAKU_CONFIG: "/b.json" }, w.warn)).toBe("/a.json");
    expect(w.lines).toEqual([]);
    expect(defaultConfigPath({ HIKYAKU_CONFIG: "/b.json" }, w.warn)).toBe("/b.json");
    expect(w.lines[0]).toMatch(/HIKYAKU_CONFIG is deprecated.*KAIROKU_DAEMON_CONFIG/);
    expect(defaultConfigPath({}, w.warn)).toMatch(/\.kairoku\/config\.json$/);
  });

  test("RF-006: the token comes from the environment or token.env beside the config, never config.json", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ token: "from-the-file" }));
    const w = warnings();

    expect(() => loadConfig(path, {}, w.warn)).toThrow(/KAIROKU_DAEMON_TOKEN/);
    expect(loadConfig(path, { KAIROKU_DAEMON_TOKEN: "new", HIKYAKU_TOKEN: "old" }, w.warn).token).toBe("new");
    expect(w.lines).toEqual([]);
    expect(loadConfig(path, { HIKYAKU_TOKEN: "old" }, w.warn).token).toBe("old");
    expect(w.lines[0]).toMatch(/HIKYAKU_TOKEN is deprecated.*KAIROKU_DAEMON_TOKEN/);

    writeFileSync(join(dir, "token.env"), "KAIROKU_DAEMON_TOKEN=from-token-env\n");
    expect(loadConfig(path, {}, w.warn).token).toBe("from-token-env");
    writeFileSync(join(dir, "token.env"), "# generated\nHIKYAKU_TOKEN=legacy-token-env\n");
    expect(loadConfig(path, {}, w.warn).token).toBe("legacy-token-env");
  });

  test("a missing config file is fine; defaults apply", () => {
    const config = loadConfig(join(tmp(), "absent.json"), { KAIROKU_DAEMON_TOKEN: "t" });
    expect(config.listen.host).toBe("127.0.0.1");
    expect(config.maxConcurrent).toBe(2);
    expect(config.keepWorktreeOnFailure).toBe(false);
    expect(config.defaultTimeoutSec).toBe(DEFAULT_TIMEOUT_SEC);
    expect(config.runsDir).toMatch(/\.kairoku\/runs$/);
  });

  test("file values win over defaults, and a bad bind in the file is caught", () => {
    const dir = tmp();
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        listen: { host: "192.168.23.167", port: 9000 },
        maxConcurrent: 4,
        repoPath: "/srv/kairoku",
        keepWorktreeOnFailure: true,
      }),
    );
    const config = loadConfig(path, { KAIROKU_DAEMON_TOKEN: "t" });
    expect(config.listen).toEqual({ host: "192.168.23.167", port: 9000 });
    expect(config.maxConcurrent).toBe(4);
    expect(config.repoPath).toBe("/srv/kairoku");
    expect(config.keepWorktreeOnFailure).toBe(true);

    writeFileSync(path, JSON.stringify({ listen: { host: "0.0.0.0" } }));
    expect(() => loadConfig(path, { KAIROKU_DAEMON_TOKEN: "t" })).toThrow(/RF-006/);
  });

  test("the test seams are never populated from the config file", () => {
    const path = join(tmp(), "config.json");
    writeFileSync(path, JSON.stringify({ commandOverride: ["rm", "-rf"], worktreeOps: {} }));
    const config = loadConfig(path, { KAIROKU_DAEMON_TOKEN: "t" });
    expect(config.commandOverride).toBeUndefined();
    expect(config.worktreeOps).toBeUndefined();
  });

  test("a malformed config file fails loudly rather than silently defaulting", () => {
    const path = join(tmp(), "config.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path, { KAIROKU_DAEMON_TOKEN: "t" })).toThrow();
  });
});

describe("migrateHome", () => {
  test("copies ~/.hikyaku to ~/.kairoku once, renames the token line, keeps mode 600, leaves worktrees to git", () => {
    const home = tmp();
    expect(migrateHome(home)).toBe("none");

    const old = join(home, ".hikyaku");
    mkdirSync(join(old, "runs", "r1"), { recursive: true });
    mkdirSync(join(old, "worktrees", "r1"), { recursive: true });
    writeFileSync(join(old, "config.json"), '{ "maxConcurrent": 3 }\n');
    writeFileSync(join(old, "token.env"), "HIKYAKU_TOKEN=abc123\n");
    chmodSync(join(old, "token.env"), 0o600);
    writeFileSync(join(old, "runs", "r1", "events.jsonl"), "{}\n");

    expect(migrateHome(home)).toBe("migrated");
    const fresh = join(home, ".kairoku");
    expect(readFileSync(join(fresh, "config.json"), "utf8")).toBe('{ "maxConcurrent": 3 }\n');
    expect(readFileSync(join(fresh, "token.env"), "utf8")).toBe("KAIROKU_DAEMON_TOKEN=abc123\n");
    expect(statSync(join(fresh, "token.env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(fresh, "runs", "r1", "events.jsonl"))).toBe(true);
    expect(existsSync(join(fresh, "worktrees"))).toBe(false);
    // A copy, never a move: the old daemon keeps working until it is replaced.
    expect(existsSync(join(old, "token.env"))).toBe(true);

    expect(migrateHome(home)).toBe("already");
  });

  test("a fresh machine with only ~/.kairoku is 'already'", () => {
    const home = tmp();
    mkdirSync(join(home, ".kairoku"));
    expect(migrateHome(home)).toBe("already");
  });
});
