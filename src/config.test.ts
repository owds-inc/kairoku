import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBindable, loadConfig, DEFAULT_TIMEOUT_SEC } from "./config";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "hikyaku-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("config", () => {
  test("RF-006: refuses a wildcard bind", () => {
    expect(() => assertBindable("0.0.0.0")).toThrow(/RF-006/);
    expect(() => assertBindable("::")).toThrow(/RF-006/);
    expect(() => assertBindable("")).toThrow(/RF-006/);
    expect(() => assertBindable("192.168.23.167")).not.toThrow();
  });

  test("RF-006: the token comes from the environment, never the file", () => {
    const path = join(tmp(), "config.json");
    writeFileSync(path, JSON.stringify({ token: "from-the-file" }));

    expect(() => loadConfig(path, {})).toThrow(/HIKYAKU_TOKEN/);
    expect(loadConfig(path, { HIKYAKU_TOKEN: "from-env" }).token).toBe("from-env");
  });

  test("a missing config file is fine; defaults apply", () => {
    const config = loadConfig(join(tmp(), "absent.json"), {
      HIKYAKU_TOKEN: "t",
    });
    expect(config.listen.host).toBe("127.0.0.1");
    expect(config.maxConcurrent).toBe(2);
    expect(config.keepWorktreeOnFailure).toBe(false);
    expect(config.defaultTimeoutSec).toBe(DEFAULT_TIMEOUT_SEC);
    expect(config.runsDir).toMatch(/\.hikyaku\/runs$/);
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
    const config = loadConfig(path, { HIKYAKU_TOKEN: "t" });
    expect(config.listen).toEqual({ host: "192.168.23.167", port: 9000 });
    expect(config.maxConcurrent).toBe(4);
    expect(config.repoPath).toBe("/srv/kairoku");
    expect(config.keepWorktreeOnFailure).toBe(true);

    writeFileSync(path, JSON.stringify({ listen: { host: "0.0.0.0" } }));
    expect(() => loadConfig(path, { HIKYAKU_TOKEN: "t" })).toThrow(/RF-006/);
  });

  test("the test seams are never populated from the config file", () => {
    const path = join(tmp(), "config.json");
    writeFileSync(
      path,
      JSON.stringify({ commandOverride: ["rm", "-rf"], worktreeOps: {} }),
    );
    const config = loadConfig(path, { HIKYAKU_TOKEN: "t" });
    expect(config.commandOverride).toBeUndefined();
    expect(config.worktreeOps).toBeUndefined();
  });

  test("a malformed config file fails loudly rather than silently defaulting", () => {
    const path = join(tmp(), "config.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path, { HIKYAKU_TOKEN: "t" })).toThrow();
  });
});
