/**
 * `kairoku env` — the daemon's own value store, layer 2 of §20.11.
 *
 * The rule this file exists to hold: `list` prints NAMES. A store command that
 * echoes a value puts it in a terminal, a scrollback and, sooner or later, a
 * pasted issue.
 */

import { describe, expect, test } from "bun:test";
import { run, usage } from "./env";
import { fakeIo, type FakeIo } from "./testkit";

const STORE = "/home/tester/.kairoku/env/owds-inc/kairoku/test.env";

function io(over: Partial<FakeIo> = {}): FakeIo {
  const fake = fakeIo(over);
  fake.files["/home/tester/.kairoku/config.json"] = JSON.stringify({ repoPath: "/home/tester/work/kairoku" });
  fake.canned["git -C /home/tester/work/kairoku remote get-url origin"] = {
    stdout: "git@github.com:owds-inc/kairoku.git\n",
  };
  return fake;
}

describe("kairoku env set", () => {
  test("writes KEY=value into the repo's own store, mode 600", async () => {
    const fake = io();
    expect(await run(["set", "STRIPE_KEY=sk_live_x"], fake)).toBe(0);
    expect(fake.files[STORE]).toBe("STRIPE_KEY=sk_live_x\n");
    expect(fake.modes[STORE]).toBe(0o600);
    // The name is confirmed; the value is not echoed back.
    expect(fake.lines.join("\n")).toContain("STRIPE_KEY");
    expect(fake.lines.join("\n")).not.toContain("sk_live_x");
  });

  test("a value containing `=` keeps all of it — only the FIRST `=` splits", async () => {
    const fake = io();
    await run(["set", "DSN=postgres://u:p@h/db?a=b"], fake);
    expect(fake.files[STORE]).toBe("DSN=postgres://u:p@h/db?a=b\n");
  });

  test("adds to what is already there, and replaces a key rather than duplicating it", async () => {
    const fake = io();
    fake.files[STORE] = "A=1\nB=2\n";
    await run(["set", "B=two", "C=3"], fake);
    expect(fake.files[STORE]).toBe("A=1\nB=two\nC=3\n");
  });

  test("--repo and --profile pick a different store", async () => {
    const fake = io();
    await run(["set", "A=1", "--repo", "owds-inc/kairoku-docs", "--profile", "staging"], fake);
    expect(fake.files["/home/tester/.kairoku/env/owds-inc/kairoku-docs/staging.env"]).toBe("A=1\n");
  });

  test("an argument that is not KEY=value is refused, with the usage", async () => {
    const fake = io();
    expect(await run(["set", "STRIPE_KEY"], fake)).toBe(2);
    expect(fake.errors.join("\n")).toContain("KEY=value");
    expect(fake.files[STORE]).toBeUndefined();
  });
});

describe("kairoku env list", () => {
  test("prints the NAMES and never the values", async () => {
    const fake = io();
    fake.files[STORE] = "STRIPE_KEY=sk_live_x\nDATABASE_URL=postgres://u:p@h/db\n";
    expect(await run(["list"], fake)).toBe(0);
    const out = fake.lines.join("\n");
    expect(out).toContain("STRIPE_KEY");
    expect(out).toContain("DATABASE_URL");
    expect(out).not.toContain("sk_live_x");
    expect(out).not.toContain("postgres://u:p@h/db");
    // The path, so an operator can find the file they are being told about.
    expect(out).toContain(STORE);
  });

  test("an empty store says so rather than printing nothing", async () => {
    const fake = io();
    expect(await run(["list"], fake)).toBe(0);
    expect(fake.lines.join("\n")).toContain("no values");
  });
});

describe("kairoku env rm", () => {
  test("removes the named keys and keeps the rest", async () => {
    const fake = io();
    fake.files[STORE] = "A=1\nB=2\nC=3\n";
    expect(await run(["rm", "B"], fake)).toBe(0);
    expect(fake.files[STORE]).toBe("A=1\nC=3\n");
  });

  test("a key that was not there is said plainly, not treated as a failure", async () => {
    const fake = io();
    fake.files[STORE] = "A=1\n";
    expect(await run(["rm", "NOPE"], fake)).toBe(0);
    expect(fake.lines.join("\n")).toContain("NOPE");
  });
});

describe("kairoku env import", () => {
  test("merges a dotenv file in, and never prints what was in it", async () => {
    const fake = io();
    fake.files[STORE] = "A=old\n";
    fake.files["/tmp/prod.env"] = "# a comment\nA=new\nSTRIPE_KEY=sk_live_x\n\n";
    expect(await run(["import", "/tmp/prod.env"], fake)).toBe(0);
    expect(fake.files[STORE]).toBe("A=new\nSTRIPE_KEY=sk_live_x\n");
    const out = fake.lines.join("\n");
    expect(out).toContain("2");
    expect(out).not.toContain("sk_live_x");
  });

  test("a file that is not there is an error, not an empty import", async () => {
    const fake = io();
    expect(await run(["import", "/tmp/absent.env"], fake)).toBe(1);
    expect(fake.errors.join("\n")).toContain("/tmp/absent.env");
  });
});

describe("kairoku env — the repo it belongs to", () => {
  test("a checkout whose origin cannot be read refuses rather than guessing", async () => {
    // Writing to the wrong repo's store would hand one project's values to
    // another project's agents.
    const fake = io();
    fake.canned["git -C /home/tester/work/kairoku remote get-url origin"] = { code: 128, stdout: "" };
    expect(await run(["list"], fake)).toBe(1);
    expect(fake.errors.join("\n")).toContain("--repo");
  });

  test("an unknown subcommand prints the usage", async () => {
    const fake = io();
    expect(await run(["frobnicate"], fake)).toBe(2);
    expect(fake.errors.join("\n")).toContain("kairoku env");
  });

  test("the usage names every subcommand", () => {
    for (const word of ["set", "import", "list", "rm", "--repo", "--profile"]) {
      expect(usage).toContain(word);
    }
  });
});
