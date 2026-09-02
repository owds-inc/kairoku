#!/usr/bin/env bun
/**
 * The release build: one single-binary executable per target, checksums.txt
 * (sha256sum format), and the Homebrew formula rendered with those checksums
 * so the tap never carries a hand-typed hash. `bun run build:release`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { version } from "../package.json";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

export function formula(version: string, sha256: Record<string, string>): string {
  const asset = (t: string) => `kairoku-${t}`;
  const stanza = (t: string) =>
    `      url "https://github.com/owds-inc/kairoku/releases/download/v${version}/${asset(t)}"\n` +
    `      sha256 "${sha256[asset(t)]}"`;
  return `class Kairoku < Formula
  desc "Set up the Kairoku Claude Code plugin and orchestration daemon"
  homepage "https://github.com/owds-inc/kairoku"
  license "MIT"

  on_macos do
    on_arm do
${stanza("darwin-arm64")}
    end
    on_intel do
${stanza("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${stanza("linux-arm64")}
    end
    on_intel do
${stanza("linux-x64")}
    end
  end

  def install
    bin.install Dir["kairoku-*"].first => "kairoku"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kairoku version")
  end
end
`;
}

if (import.meta.main) {
  mkdirSync("dist", { recursive: true });
  const sums: Record<string, string> = {};
  for (const target of TARGETS) {
    const out = `dist/kairoku-${target}`;
    const build = Bun.spawnSync(
      ["bun", "build", "--compile", `--target=bun-${target}`, "src/cli/main.ts", "--outfile", out],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (build.exitCode !== 0) process.exit(build.exitCode);
    sums[`kairoku-${target}`] = createHash("sha256").update(readFileSync(out)).digest("hex");
  }
  writeFileSync("dist/checksums.txt", Object.entries(sums).map(([name, sum]) => `${sum}  ${name}\n`).join(""));
  writeFileSync("dist/kairoku.rb", formula(version, sums));
  console.log(readFileSync("dist/checksums.txt", "utf8"));
}
