/**
 * `kairoku update` — replace the running binary with the latest GitHub
 * release's asset for this platform, once its sha256 matches checksums.txt.
 * A Homebrew install defers to brew, which owns everything under the Cellar.
 */

import { createHash } from "node:crypto";
import { version } from "../../package.json";
import type { Io } from "./io";

export const REPO = "owds-inc/kairoku";

export const usage = `usage: kairoku update

  Replaces this binary with the latest GitHub release's asset for this
  platform after its sha256 matches the release's checksums.txt. A Homebrew
  install is left to \`brew upgrade kairoku\`.`;

/** `kairoku-<os>-<arch>` for the four release targets; null for anything else. */
export function assetName(platform: string, arch: string): string | null {
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const cpu = arch === "arm64" || arch === "x64" ? arch : null;
  return os && cpu ? `kairoku-${os}-${cpu}` : null;
}

type Release = { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };

export async function run(_args: string[], io: Io): Promise<number> {
  if (io.execPath.includes("/Cellar/")) {
    io.out("kairoku was installed by Homebrew — update it with: brew upgrade kairoku");
    return 0;
  }
  const asset = assetName(io.platform, io.arch);
  if (asset === null) {
    io.err(`no release asset for ${io.platform}/${io.arch}`);
    return 1;
  }
  const res = await io.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    io.err(`could not read the latest release of ${REPO}: HTTP ${res.status}`);
    return 1;
  }
  const rel = (await res.json()) as Release;
  const latest = rel.tag_name.replace(/^v/, "");
  if (latest === version) {
    io.out(`kairoku ${version} is already the latest`);
    return 0;
  }
  const url = (name: string) => rel.assets.find((a) => a.name === name)?.browser_download_url;
  const binUrl = url(asset);
  const sumUrl = url("checksums.txt");
  if (!binUrl || !sumUrl) {
    io.err(`release ${rel.tag_name} has no ${asset} or no checksums.txt`);
    return 1;
  }
  const [bin, sums] = await Promise.all([io.fetch(binUrl), io.fetch(sumUrl)]);
  if (!bin.ok || !sums.ok) {
    io.err(`download failed: ${asset} HTTP ${bin.status}, checksums.txt HTTP ${sums.status}`);
    return 1;
  }
  const bytes = new Uint8Array(await bin.arrayBuffer());
  const expected = (await sums.text()).match(new RegExp(`^([0-9a-f]{64})\\s+\\*?${asset}$`, "m"))?.[1];
  if (!expected) {
    io.err(`checksums.txt has no entry for ${asset}`);
    return 1;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    io.err(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    return 1;
  }
  const staged = `${io.execPath}.new`;
  try {
    io.writeFile(staged, bytes, 0o755);
    io.rename(staged, io.execPath);
  } catch (e) {
    io.err(`cannot replace ${io.execPath}: ${(e as Error).message} — rerun with sudo, or reinstall with install.sh`);
    return 1;
  }
  io.out(`kairoku ${version} → ${latest} (${io.execPath})`);
  return 0;
}
