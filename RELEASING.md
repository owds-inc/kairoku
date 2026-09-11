# Releasing the Kairoku CLI

This repo lives on GitHub (`owds-inc/kairoku`), so it is the one Kairoku
repo whose source of truth and release home are the same place. The
Homebrew formula is published to `owds-inc/homebrew-tap`
(`Formula/kairoku.rb`).

Releases are **tag-driven**: a `vX.Y.Z` tag is the only trigger. The version bump
and the CHANGELOG entry land as an ordinary reviewed PR first — the same flow
kairokud and kairoku-desktop use, with no release-please and no bot that tags.

## 1. Cut the version (local)

```sh
bun run cut --dry-run 1.0.1   # prints the plan and the new CHANGELOG section
bun run cut 1.0.1
```

`scripts/cut.ts` bumps `package.json` and prepends a `CHANGELOG.md` section built
from `git log --format=%s` since the last `vX.Y.Z` tag, grouped under the same
headings kairokud's changelog uses. Read the section and edit it before
committing — it is a starting draft.

> `v1.0.0` was tagged before this automation, ahead of `package.json` (which
> still said `0.1.0`). `bun run cut` reports both numbers, so check them: the
> next release must be above the highest existing tag, since the workflow's
> first step asserts the tag equals `package.json`'s version.

Then open the PR, get it reviewed, merge, and tag `main`:

```sh
git switch main && git pull --ff-only
git tag -a v1.0.1 -m "kairoku v1.0.1" && git push origin v1.0.1
```

## 2. `.github/workflows/release.yml`

On a `v*` tag it:

1. asserts the tag equals `package.json`'s `version`;
2. runs `bun test` and `bunx tsc --noEmit` — a red test never ships;
3. runs `bun run build:release`, which compiles one single-file binary per target
   (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), writes
   `dist/checksums.txt`, and renders `dist/kairoku.rb` **with those checksums**,
   so the tap never carries a hand-typed hash;
4. creates the GitHub release with the binaries, `checksums.txt` and the formula;
5. pushes `dist/kairoku.rb` to `owds-inc/homebrew-tap` as `Formula/kairoku.rb`,
   committing as `kairoku <tag>`. The step is **skipped, not failed**, when
   `HOMEBREW_TAP_TOKEN` is not configured, and exits cleanly when the formula
   already matches.

### Prerelease tags

A tag with a prerelease suffix (`v1.0.1-beta.1` — `bun run cut` accepts one) is
published with `--prerelease`, and the tap push is **skipped**. Both matter
because the two default install paths resolve a pointer, not a tag:

- `install.sh` downloads from `releases/latest/download`, and `kairoku update`
  reads `releases/latest` — a prerelease not marked as one *is* `latest`;
- the tap is what `brew install owds-inc/tap/kairoku` resolves, so a beta formula
  there would become the default install.

Promote a prerelease by cutting the final version and tagging that.

Installing is then `brew install owds-inc/tap/kairoku`.

## Required secrets

| Secret | Needed for | Today |
| --- | --- | --- |
| `GITHUB_TOKEN` | the release itself | provided automatically by Actions (`permissions: contents: write`) |
| `HOMEBREW_TAP_TOKEN` | the tap push | **unset** — a fine-grained PAT with `contents: write` on `owds-inc/homebrew-tap` only. Until it exists, copy `dist/kairoku.rb` from the release into the tap by hand |

## Checks

```sh
bun test scripts/cut.test.ts   # the changelog grouping and insertion
actionlint .github/workflows/release.yml
```
