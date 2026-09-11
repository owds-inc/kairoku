import { describe, expect, test } from "bun:test";

import { changelogSection, withSection } from "./cut";

describe("changelogSection", () => {
  test("groups conventional commits under the shared headings, in order", () => {
    const section = changelogSection(
      "1.0.1",
      ["feat(doctor): slack PASS/WARN/FAIL", "fix: drop the stale guard", "doc(release): note the flow"],
      "2026-09-11",
    );
    expect(section.startsWith("## [1.0.1] - 2026-09-11\n\n")).toBe(true);
    expect(section).toContain("### 🚀 Features\n\n- *(doctor)* Slack PASS/WARN/FAIL");
    expect(section).toContain("### 🐛 Bug Fixes\n\n- Drop the stale guard");
    // `doc` is folded into Documentation, the heading the other repos use.
    expect(section).toContain("### 📚 Documentation\n\n- *(release)* Note the flow");
    expect(section.indexOf("Features")).toBeLessThan(section.indexOf("Bug Fixes"));
  });

  test("keeps a subject that is not a conventional commit", () => {
    const section = changelogSection("1.0.1", ["tidy up without a type"], "2026-09-11");
    expect(section).toContain("### ⚙️ Miscellaneous Tasks\n\n- Tidy up without a type");
  });

  test("says so when there is nothing to release", () => {
    expect(changelogSection("1.0.1", [], "2026-09-11")).toContain("- No commits since the last tag");
  });
});

describe("withSection", () => {
  test("inserts above the newest section and below the file header", () => {
    const before = "# Changelog\n\nAll notable changes.\n\n## [1.0.0] - 2026-09-10\n\n- Old\n";
    const after = withSection(before, changelogSection("1.0.1", ["fix: a thing"], "2026-09-11"));
    expect(after.indexOf("## [1.0.1]")).toBeGreaterThan(after.indexOf("# Changelog"));
    expect(after.indexOf("## [1.0.1]")).toBeLessThan(after.indexOf("## [1.0.0]"));
    expect(after).toContain("- A thing\n\n## [1.0.0]");
  });

  test("starts a changelog that has no sections yet", () => {
    const after = withSection("# Changelog\n\nAll notable changes.\n", "## [1.0.1] - 2026-09-11\n\n- x\n");
    expect(after).toBe("# Changelog\n\nAll notable changes.\n\n## [1.0.1] - 2026-09-11\n\n- x\n");
  });
});
