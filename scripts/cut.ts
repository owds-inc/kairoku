#!/usr/bin/env bun
/**
 * Cut a release: bump package.json, prepend a CHANGELOG section built from the
 * conventional commits since the last vX.Y.Z tag, and print the tag command.
 *
 * Nothing here commits, tags, or talks to a network — the tag is what triggers
 * .github/workflows/release.yml (RELEASING.md), so it stays a human step.
 *
 * `bun run cut [--dry-run] <version>`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CHANGELOG = "CHANGELOG.md";
const HEADER = "# Changelog\n\nAll notable changes to the Kairoku CLI are documented in this file.\n\n";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// The same headings kairokud's CHANGELOG uses, so a reader moving between the
// three repos sees one shape.
const HEADINGS: Record<string, string> = {
  feat: "### 🚀 Features",
  fix: "### 🐛 Bug Fixes",
  docs: "### 📚 Documentation",
  perf: "### ⚡ Performance",
  refactor: "### 🔧 Refactor",
  test: "### 🧪 Testing",
  misc: "### ⚙️ Miscellaneous Tasks",
};
const ORDER = ["feat", "fix", "docs", "perf", "refactor", "test", "misc"] as const;

/** Group commit subjects into one dated section. Subjects that are not
 *  conventional commits land under Miscellaneous rather than vanishing. */
export function changelogSection(version: string, subjects: string[], date: string): string {
  const buckets = new Map<string, string[]>();
  for (const subject of subjects) {
    const parsed = /^([a-z]+)(?:\(([^)]*)\))?!?: (.*)$/.exec(subject);
    let type = "misc";
    let scope = "";
    let body = subject;
    if (parsed) {
      const declared = parsed[1] === "doc" ? "docs" : parsed[1]!;
      type = declared in HEADINGS ? declared : "misc";
      scope = parsed[2] ?? "";
      body = parsed[3]!;
    }
    const entry = `- ${scope ? `*(${scope})* ` : ""}${body.charAt(0).toUpperCase()}${body.slice(1)}`;
    const bucket = buckets.get(type);
    if (bucket) bucket.push(entry);
    else buckets.set(type, [entry]);
  }
  const groups = ORDER.filter((key) => buckets.has(key)).map(
    (key) => `${HEADINGS[key]}\n\n${buckets.get(key)!.join("\n")}\n`,
  );
  const body = groups.length > 0 ? groups.join("\n") : `${HEADINGS.misc}\n\n- No commits since the last tag\n`;
  return `## [${version}] - ${date}\n\n${body}`;
}

/** Insert the section above the newest existing one, keeping the file header. */
export function withSection(changelog: string, section: string): string {
  const at = changelog.search(/^## \[/m);
  if (at === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const dryRun = args.includes("--dry-run");
  const version = args.find((arg) => !arg.startsWith("-"));
  if (!version || !SEMVER.test(version)) {
    console.error("usage: bun run cut [--dry-run] <version>");
    console.error("version must be MAJOR.MINOR.PATCH with an optional prerelease");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (manifest.version === version) {
    console.error(`already at ${version}`);
    process.exit(2);
  }
  const lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*"]);
  const subjects = git(["log", "--no-merges", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : [])])
    .split("\n")
    .filter(Boolean);
  const section = changelogSection(version, subjects, new Date().toISOString().slice(0, 10));

  console.log(`version:  ${manifest.version} -> ${version}`);
  console.log(`commits:  since ${lastTag || "the start of history"}`);
  console.log();
  console.log(section);
  if (dryRun) {
    console.log("--dry-run: nothing written");
    process.exit(0);
  }

  manifest.version = version;
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : HEADER;
  writeFileSync(CHANGELOG, withSection(existing, section));

  console.log(`
wrote: package.json, ${CHANGELOG}

land it, then tag main:
  git switch -c release/v${version}
  git commit -am "chore(release): v${version}"
  git push -u origin release/v${version}   # open the PR, get it reviewed and merged

  git switch main && git pull --ff-only
  git tag -a v${version} -m "kairoku v${version}" && git push origin v${version}`);
}
