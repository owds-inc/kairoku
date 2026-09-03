import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envStorePath,
  mergeEnv,
  readCheckoutEnv,
  readEnvStore,
  resolveSecrets,
  substitute,
  writeEnvStore,
  type ResolverDeps,
} from "./env";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "kairoku-env-"));
}

describe("substitute", () => {
  test("replaces ${NAME} with the allocated value", () => {
    expect(substitute("postgres://127.0.0.1:${PG_PORT}/main", { PG_PORT: 20001 })).toBe(
      "postgres://127.0.0.1:20001/main",
    );
  });

  test("a name nobody allocated is LEFT ALONE, never blanked", () => {
    // A silently emptied `${DB}` produces a plausible-looking URL that points
    // nowhere; leaving the placeholder makes the failure name itself.
    expect(substitute("a=${NOPE}", {})).toBe("a=${NOPE}");
  });
});

describe("mergeEnv — low to high (§20.11)", () => {
  test("each layer wins over the one below it, and nothing below is lost", () => {
    const merged = mergeEnv({
      checkout: { A: "checkout", B: "checkout", C: "checkout", D: "checkout" },
      store: { B: "store", C: "store", D: "store" },
      secrets: { C: "secret", D: "secret" },
      perRun: { D: "per-run" },
    });
    expect(merged).toEqual({ A: "checkout", B: "store", C: "secret", D: "per-run" });
  });

  test("an empty merge is an empty object, not the daemon's own environment", () => {
    expect(mergeEnv({ checkout: {}, store: {}, secrets: {}, perRun: {} })).toEqual({});
  });
});

describe("the daemon's env store", () => {
  test("one file per repo and profile, under ~/.kairoku/env", () => {
    expect(envStorePath("/home/x", "owds-inc/kairoku", "test")).toBe(
      "/home/x/.kairoku/env/owds-inc/kairoku/test.env",
    );
  });

  test("a repo or profile name that tries to climb out is refused", () => {
    expect(() => envStorePath("/home/x", "../../etc", "test")).toThrow(/must not contain/);
    expect(() => envStorePath("/home/x", "owds-inc/kairoku", "../shadow")).toThrow(/must not contain/);
  });

  test("written 0600 and read back", () => {
    const home = temp();
    try {
      const path = envStorePath(home, "owds-inc/kairoku", "test");
      writeEnvStore(path, { STRIPE_KEY: "sk_live_x", OTHER: "2" });
      expect(readEnvStore(path)).toEqual({ STRIPE_KEY: "sk_live_x", OTHER: "2" });
      expect(Bun.file(path).size).toBeGreaterThan(0);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no store file is an empty layer, not a failure", () => {
    expect(readEnvStore(join(temp(), "nothing.env"))).toEqual({});
  });
});

describe("readCheckoutEnv — the profile's own files, from the worktree", () => {
  test("later files in the list win, and a missing one is skipped", () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, ".env"), "A=1\nB=1\n");
      writeFileSync(join(dir, ".env.local"), "B=2\n");
      expect(readCheckoutEnv(dir, [".env", ".env.local", ".env.absent"])).toEqual({ A: "1", B: "2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no files named is an empty layer", () => {
    expect(readCheckoutEnv(temp(), [])).toEqual({});
  });
});

describe("resolveSecrets — resolved HERE, and failing safely", () => {
  function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
    return {
      which: () => "/usr/local/bin/tool",
      exec: async () => ({ code: 0, stdout: "resolved-value\n", stderr: "" }),
      ...over,
    };
  }

  test("a plain value is delivered as it is", async () => {
    const result = await resolveSecrets({ A: "plain" }, deps());
    expect(result).toEqual({ ok: true, values: { A: "plain" } });
  });

  test("an op:// reference is resolved by the 1Password CLI, trailing newline stripped", async () => {
    const argv: string[][] = [];
    const result = await resolveSecrets(
      { A: { ref: "op://vault/item/field" } },
      deps({
        exec: async (command) => {
          argv.push(command);
          return { code: 0, stdout: "s3cret\n", stderr: "" };
        },
      }),
    );
    expect(result).toEqual({ ok: true, values: { A: "s3cret" } });
    expect(argv[0]).toEqual(["/usr/local/bin/tool", "read", "--no-newline", "op://vault/item/field"]);
  });

  test("an AWS Secrets Manager ARN is resolved by the aws CLI", async () => {
    const argv: string[][] = [];
    const arn = "arn:aws:secretsmanager:ca-central-1:1:secret:prod/db-AbCdEf";
    await resolveSecrets(
      { A: { ref: arn } },
      deps({
        exec: async (command) => {
          argv.push(command);
          return { code: 0, stdout: "from-aws", stderr: "" };
        },
      }),
    );
    expect(argv[0]).toEqual([
      "/usr/local/bin/tool",
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      arn,
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
  });

  test("a missing resolver fails the run, naming the KEY and nothing else", async () => {
    const result = await resolveSecrets(
      { STRIPE_KEY: { ref: "op://vault/stripe/key" } },
      deps({ which: () => null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("STRIPE_KEY");
    expect(result.error).toContain("1Password");
    // NEVER the locator: a vault path names the vault, the item and the field.
    expect(result.error).not.toContain("op://vault/stripe/key");
  });

  test("a reference in a scheme nobody here knows fails closed, by name", async () => {
    const result = await resolveSecrets({ K: { ref: "vault://kv/data/x" } }, deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("K");
    expect(result.error).not.toContain("vault://kv/data/x");
  });

  test("a resolver that fails does not leak its stderr — that is where a value ends up", async () => {
    const result = await resolveSecrets(
      { K: { ref: "op://v/i/f" } },
      deps({ exec: async () => ({ code: 1, stdout: "", stderr: "failed reading op://v/i/f = hunter2" }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("K");
    expect(result.error).not.toContain("hunter2");
    expect(result.error).not.toContain("op://v/i/f");
  });

  test("nothing delivered is an empty layer", async () => {
    expect(await resolveSecrets({}, deps())).toEqual({ ok: true, values: {} });
  });
});
