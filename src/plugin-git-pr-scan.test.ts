import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The git-pr skill's forge branch (R12; DECISIONS §79.6 item 4).
 *
 * WHAT IT DEFENDS. This skill's prose is read by a model at runtime in someone
 * else's session, and until this file existed nothing in the suite read it at
 * all. Two forge paths now live in it and each is one careless edit from being
 * lost. The detection block is EXTRACTED FROM THE SKILL AND EXECUTED rather
 * than restated here: a rule the test and the skill each spell separately
 * agrees with itself about a broken skill.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const SKILL = read("plugin/skills/git-pr/SKILL.md");
const ROLE = read("src/daemon/roles/implementer.md");

/**
 * The COMMANDS the skill tells an agent to run, not its prose about them.
 * Every pin below is against this and not against SKILL: the prose says the
 * words `--draft` and `--description-file` in order to forbid them, so a
 * whole-file `not.toContain` would fail on the very sentence that carries the
 * rule — and a whole-file `toContain` would be satisfied by a mention.
 */
const BLOCKS = [...SKILL.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
const COMMANDS = BLOCKS.join("\n");

/** The one block that reads the remote — tests 4 to 6 execute it, not a copy of it. */
const DETECT = BLOCKS.find((b) => b.includes("git remote get-url origin"));

/**
 * The skill's own detection block, run against a throwaway git repository
 * whose origin is `remote`. The block is appended with an echo of the host it
 * resolved, and the pipered stdout is returned trimmed — asserted against, not
 * restated.
 */
async function runDetect(remote: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "kairoku-gitpr-"));
  try {
    Bun.spawnSync(["/bin/sh", "-c", `git init -q && git remote add origin "${remote}"`], {
      cwd: dir,
    });
    const proc = Bun.spawn(["/bin/sh", "-c", `${DETECT}\necho "$host"`], {
      cwd: dir,
      stdout: "pipe",
    });
    return (await new Response(proc.stdout).text()).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("git-pr — the forge branch", () => {
  test("the GitHub sentence is byte-identical to the one this lane inherited", () => {
    expect(SKILL).toContain(
      "Open it with `gh pr create`. Build the body from the epic and its stories — never a generic",
    );
  });

  test("the GitLab arm is present: glab mr create with an explicit target branch", () => {
    expect(COMMANDS).toContain("glab mr create");
    expect(COMMANDS).toContain("--target-branch");
    expect(DETECT).toBeDefined();
  });

  test("never a Draft, and no --description-file", () => {
    expect(COMMANDS).not.toContain("--draft");
    expect(COMMANDS).not.toContain("Draft:");
    expect(COMMANDS).not.toContain("WIP:");
    expect(COMMANDS).not.toContain("--description-file");
  });

  test("the skill's own detection block resolves a GitLab https remote to gitlab.com", async () => {
    expect(await runDetect("https://gitlab.com/owds-inc/kairoku/kairokud.git")).toBe("gitlab.com");
  });

  test("the same block resolves a GitLab scp-form remote to gitlab.com", async () => {
    expect(await runDetect("git@gitlab.com:owds-inc/kairoku/kairoku-desktop.git")).toBe("gitlab.com");
  });

  test("the same block resolves a GitHub ssh remote to github.com", async () => {
    expect(await runDetect("git@github.com:owds-inc/kairoku.git")).toBe("github.com");
  });

  test("the daemon's own implementer role prompt names both forges", () => {
    expect(ROLE).toContain("glab mr create");
    expect(ROLE).toContain("gh pr create");
  });
});