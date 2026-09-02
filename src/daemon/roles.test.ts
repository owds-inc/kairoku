import { describe, expect, test } from "bun:test";
import { getRole, roleNames } from "./roles";

describe("roles (RF-009)", () => {
  test("v0 ships exactly one role: executor", () => {
    expect(roleNames()).toEqual(["executor"]);
  });

  test("an undeclared role resolves to nothing, so callers refuse it", () => {
    expect(getRole("reviewer")).toBeUndefined();
    expect(getRole("")).toBeUndefined();
    expect(getRole("EXECUTOR")).toBeUndefined();
  });

  test("inherited Object properties are not mistaken for roles", () => {
    // A plain `ROLES[name]` lookup would resolve "constructor" and "toString".
    expect(getRole("constructor")).toBeUndefined();
    expect(getRole("toString")).toBeUndefined();
    expect(getRole("__proto__")).toBeUndefined();
  });

  test("executor is codex, sandboxed to workspace-write, approvals never", () => {
    const role = getRole("executor")!;
    expect(role.provider).toBe("codex");

    const argv = role.build({ role: "executor", cwd: "/tmp/wt" });
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(argv).toContain("workspace-write");
    expect(argv[argv.indexOf("workspace-write") - 1]).toBe("-s");
    expect(argv).toContain('approval_policy="never"');
    expect(argv[argv.indexOf('approval_policy="never"') - 1]).toBe("-c");
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tmp/wt");
  });

  test("the brief is never an argv element — codex reads it from stdin", () => {
    // A brief beginning with `-` would otherwise be parsed as a flag, and every
    // brief would be visible in `ps`.
    const argv = getRole("executor")!.build({ role: "executor", cwd: "/tmp/wt" });
    expect(argv).not.toContain("--");
    expect(argv.at(-1)).toBe("/tmp/wt");
  });

  test("a model is passed through only when asked for", () => {
    const withModel = getRole("executor")!.build({
      role: "executor",
      cwd: "/tmp/wt",
      model: "gpt-5-codex",
    });
    expect(withModel[withModel.indexOf("-m") + 1]).toBe("gpt-5-codex");

    const without = getRole("executor")!.build({ role: "executor", cwd: "/tmp/wt" });
    expect(without).not.toContain("-m");
  });
});
