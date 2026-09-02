import { describe, expect, test } from "bun:test";
import { run } from "./setup";
import { fakeIo, type FakeIo } from "./testkit";

const pluginInstallCalls = [
  "claude plugin marketplace list --json",
  "claude plugin marketplace add owds-inc/kairoku",
  "claude plugin list --json",
  "claude plugin install kairoku@kairoku-marketplace --scope user",
];

function withClaude(): FakeIo {
  const io = fakeIo();
  io.bins.add("claude");
  io.canned["claude plugin marketplace list --json"] = { stdout: "[]" };
  io.canned["claude plugin list --json"] = { stdout: "[]" };
  return io;
}

describe("kairoku setup", () => {
  test("--plugin --yes installs the plugin without a prompt", async () => {
    const io = withClaude();
    expect(await run(["--plugin", "--yes"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(io.calls.map((c) => c.join(" "))).toEqual(pluginInstallCalls);
  });

  test("a selecting flag alone never prompts either", async () => {
    const io = withClaude();
    expect(await run(["--plugin"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(io.calls.map((c) => c.join(" "))).toEqual(pluginInstallCalls);
  });

  test("the wizard asks two questions; defaults are plugin yes, daemon no", async () => {
    const io = withClaude();
    io.answers = ["", ""];
    expect(await run([], io)).toBe(0);
    expect(io.questions).toHaveLength(2);
    expect(io.questions[0]).toMatch(/plugin.*\[Y\/n\]/i);
    expect(io.questions[1]).toMatch(/daemon.*\[y\/N\]/i);
    expect(io.calls.map((c) => c.join(" "))).toEqual(pluginInstallCalls);
    expect(io.lines.join("\n")).not.toContain("== daemon");
  });

  test("the wizard honours n / y", async () => {
    const io = withClaude();
    io.answers = ["n", "y"];
    expect(await run([], io)).toBe(0);
    expect(io.calls).toEqual([]);
    expect(io.lines.join("\n")).toContain("== daemon");
  });

  test("--daemon says the daemon setup arrives with the next release", async () => {
    const io = withClaude();
    expect(await run(["--daemon", "--yes"], io)).toBe(0);
    expect(io.calls).toEqual([]);
    expect(io.lines.join("\n")).toContain("next release");
  });

  test("--all --yes runs the plugin step then the daemon step", async () => {
    const io = withClaude();
    expect(await run(["--all", "--yes"], io)).toBe(0);
    expect(io.calls.map((c) => c.join(" "))).toEqual(pluginInstallCalls);
    expect(io.lines.join("\n")).toContain("== daemon");
  });

  test("--yes alone means --all", async () => {
    const io = withClaude();
    expect(await run(["--yes"], io)).toBe(0);
    expect(io.questions).toEqual([]);
    expect(io.calls.map((c) => c.join(" "))).toEqual(pluginInstallCalls);
    expect(io.lines.join("\n")).toContain("== daemon");
  });

  test("a failing plugin step stops the run with its exit code", async () => {
    const io = fakeIo(); // no claude on PATH
    expect(await run(["--all", "--yes"], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("npm install -g @anthropic-ai/claude-code");
    expect(io.lines.join("\n")).not.toContain("== daemon");
  });

  test("declining both is a no-op", async () => {
    const io = withClaude();
    io.answers = ["n", "n"];
    expect(await run([], io)).toBe(0);
    expect(io.calls).toEqual([]);
    expect(io.lines.join("\n")).toContain("nothing selected");
  });

  test("an unknown flag prints usage and exits 2; --help exits 0", async () => {
    const io = withClaude();
    expect(await run(["--frob"], io)).toBe(2);
    expect(io.errors.join("\n")).toContain("kairoku setup [--plugin] [--daemon] [--all] [--yes]");
    const help = withClaude();
    expect(await run(["--help"], help)).toBe(0);
    expect(help.lines.join("\n")).toContain("--daemon");
  });
});
