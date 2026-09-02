#!/bin/sh
# install.sh — install the latest kairoku release binary for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/owds-inc/kairoku/main/install.sh | sh
#
# Picks the asset for this OS/CPU from the latest GitHub release, verifies its
# sha256 against the release's checksums.txt, and installs it as `kairoku` in
# /usr/local/bin when that is writable, else ~/.local/bin (no sudo needed).
#
#   KAIROKU_INSTALL_DIR   override the install directory
#   KAIROKU_RELEASE_URL   override the asset base URL (the test suite points it
#                         at a local server)
set -eu

base="${KAIROKU_RELEASE_URL:-https://github.com/owds-inc/kairoku/releases/latest/download}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "kairoku: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "kairoku: unsupported CPU: $arch" >&2; exit 1 ;;
esac
asset="kairoku-$os-$arch"

dir="${KAIROKU_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"

expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/checksums.txt")"
if [ -z "$expected" ]; then
  echo "kairoku: checksums.txt has no entry for $asset" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
fi
if [ "$actual" != "$expected" ]; then
  echo "kairoku: checksum mismatch for $asset: expected $expected, got $actual" >&2
  exit 1
fi

chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$dir/kairoku"
echo "installed $("$dir/kairoku" version) to $dir/kairoku"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH — add:  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "next: kairoku setup"
