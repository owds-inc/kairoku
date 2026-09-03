import { describe, expect, test } from "bun:test";
import { POLICY, ROLE_NAMES, decide, isRole, toolSummary } from "./policy";

const WT = "/tmp/wt/run-1";
const ask = (role: string, tool: string, input: unknown = {}) =>
  decide({ role, tool, input, worktree: WT });

describe("policy — the roles (§20.5)", () => {
  test("there are exactly four roles, and QA is not one of them", () => {
    expect([...ROLE_NAMES]).toEqual(["implementer", "reviewer", "planner", "researcher"]);
    expect(isRole("qa")).toBe(false);
    expect(isRole("executor")).toBe(false);
    expect(isRole("implementer")).toBe(true);
  });

  test("every role declares a permission mode and a tool list", () => {
    for (const role of ROLE_NAMES) {
      expect(POLICY[role].allowedTools.length).toBeGreaterThan(0);
      expect(["acceptEdits", "dontAsk"]).toContain(POLICY[role].permissionMode);
    }
  });
});

describe("policy — the matrix (§20.8, fail closed)", () => {
  test("an unknown role is denied everything", () => {
    expect(ask("qa", "Read", { file_path: `${WT}/a.ts` })).toEqual({
      allow: false,
      reason: 'no tool policy for role "qa"',
    });
  });

  test("the implementer reads, edits, writes and runs inside its worktree", () => {
    expect(ask("implementer", "Read", { file_path: `${WT}/a.ts` }).allow).toBe(true);
    expect(ask("implementer", "Edit", { file_path: `${WT}/src/a.ts` }).allow).toBe(true);
    expect(ask("implementer", "Write", { file_path: `${WT}/new.ts` }).allow).toBe(true);
    expect(ask("implementer", "Bash", { command: "bun test" }).allow).toBe(true);
  });

  test("the reviewer reads and runs but never edits", () => {
    expect(ask("reviewer", "Read", { file_path: `${WT}/a.ts` }).allow).toBe(true);
    expect(ask("reviewer", "Bash", { command: "bun test" }).allow).toBe(true);
    expect(ask("reviewer", "Edit", { file_path: `${WT}/a.ts` })).toEqual({
      allow: false,
      reason: "the reviewer may not use Edit",
    });
    expect(ask("reviewer", "Write", { file_path: `${WT}/a.ts` }).allow).toBe(false);
  });

  test("planner and researcher get MCP and read-only, never a shell", () => {
    for (const role of ["planner", "researcher"] as const) {
      expect(ask(role, "Read", { file_path: `${WT}/a.ts` }).allow).toBe(true);
      expect(ask(role, "mcp__kairoku__get_plan", {}).allow).toBe(true);
      expect(ask(role, "Bash", { command: "ls" })).toEqual({
        allow: false,
        reason: `the ${role} may not use Bash`,
      });
      expect(ask(role, "Write", { file_path: `${WT}/a.ts` }).allow).toBe(false);
    }
  });

  test("a write outside the worktree is denied even for the implementer", () => {
    expect(ask("implementer", "Write", { file_path: "/etc/passwd" })).toEqual({
      allow: false,
      reason: "Write targets /etc/passwd, outside the run's worktree",
    });
    expect(ask("implementer", "Edit", { file_path: `${WT}/../elsewhere/a.ts` }).allow).toBe(false);
    // A relative path resolves against the worktree, so it is inside by construction.
    expect(ask("implementer", "Write", { file_path: "src/a.ts" }).allow).toBe(true);
    expect(ask("implementer", "Write", { file_path: "../escape.ts" }).allow).toBe(false);
  });

  test("a write with no readable path is denied rather than waved through", () => {
    expect(ask("implementer", "Write", {}).allow).toBe(false);
    expect(ask("implementer", "Write", { file_path: 42 }).allow).toBe(false);
  });

  test("an MCP tool of another server is not smuggled in by prefix", () => {
    expect(ask("researcher", "mcp__evil__exfiltrate", {}).allow).toBe(false);
    expect(ask("implementer", "mcp__kairoku__update_item_status", {}).allow).toBe(true);
  });

  test("every role may answer with StructuredOutput", () => {
    // Production, 2026-09-03: the SDK's own tool for `outputFormat` was on no
    // role's list, so a reviewer/planner/researcher run with a schema was
    // denied its only way to answer and failed closed (§20.4).
    for (const role of ROLE_NAMES) {
      expect(ask(role, "StructuredOutput", { verdict: "CLEAN", defects: [] }).allow).toBe(true);
    }
  });
});

describe("policy — the tool summary that reaches an event", () => {
  test("a tool call is name plus at most 200 characters of its input", () => {
    const line = toolSummary("Bash", { command: "x".repeat(500) });
    expect(line.startsWith("Bash ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(206);
  });

  test("an unserialisable input still yields a name", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolSummary("Read", cyclic)).toBe("Read");
  });
});
