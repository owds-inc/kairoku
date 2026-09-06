# CLI v0.1.0 Release Readiness Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, test-driven-development, and verification-before-completion. The dispatch already authorizes pushing and opening the PR; retain the worktree.

**Goal:** Prepare the first binary release without performing a release act.

**Architecture:** Reuse doctor's existing Io seam and marketplace constants for one reporting-only check. Fix truncation inside its existing helper; update provenance and public release instructions without changing versions or the wire limit.

**Tech Stack:** TypeScript on Bun; unchanged runtime dependencies.

**Spec:** Read-only `planned/cli-4-release-v0-1-0.md` in the planning workspace.

## Global constraints

- Base `b1a84001f3f6719ce1b35178cb70d1c74896b873`; branch `chore/release-v0-1-0`.
- Every heavy command uses `planned/lane-scripts/rq.sh` on build-app.
- Do not edit install(), link.test.ts, the waitFor timeout, any manifest version, or the fixture bytes by hand.
- App access is fetch/show/ls-tree and a final empty status only. No release acts or live marketplace mutations.

## Task 1: Measured provenance and release documentation (items 0, 1, 4–6)

- [x] Confirm no v* tag, package 0.1.0 and workflow guard, both plugin manifests 2.4.1, marketplace name and ./plugin/ source.
- [x] Fetch app dev, compare fixture bytes (empty diff at a4562fe552c1c6e082987b1f34dbbb75656773c0), verify ReleaseCard in src/components/board/ReleaseCard.tsx, record empty app status.
- [ ] Update fixtures/app-contract/README.md to that SHA; replace only ProjectStatusBlock with ReleaseCard in plugin/skills/plan/ui-story-template.md.
- [ ] In README.md remove pending; explain tagged Actions artifacts and Linux host-only execution. Leave the 2.4.0 doctor sample as example output.

## Task 2: Doctor marketplace source (item 2)

**Files:** src/cli/doctor.ts, src/cli/doctor.test.ts. Existing checks(io) returns Check[]; no new exported interface.

- [x] Measure `claude plugin marketplace list --help` and `--json`: array of {name, source, repo?, path?, installLocation}; local registration is a local directory.
- [ ] Add Io tests for wrong GitHub/directory sources, canonical GitHub source, absent registration, unavailable/malformed output, and unavailable source fields. Assert the repair commands are only printed and files remain unchanged.
- [ ] Run doctor.test.ts and events.test.ts through rq.sh; record the missing doctor check failures before implementation.
- [ ] Beside plugin checks, shell only marketplace list --json, parse defensively; PASS canonical GitHub repo, FAIL known wrong/absent registration with manual fix, WARN when source cannot be established. Never echo arbitrary source data.
- [ ] Run the targeted green and commit the tests with the fix.

## Task 3: UTF-16 boundary (item 3)

**Files:** src/daemon/events.ts, src/daemon/events.test.ts. EventBuffer.push/drain is the public test seam; truncate remains private.

- [ ] Add a regression whose input is `"x".repeat(2046) + "😀tail"`; assert no lone surrogate, JSON round-trip, and 2047-unit output. Cover ordinary truncation at 2048 units, a complete pair before the cut, and an exactly-2048-unit input unchanged.
- [ ] Observe that regression failing in the same targeted red run before the helper changes.
- [ ] Keep EVENT_TEXT_MAX=2048; return short text unchanged, set end=EVENT_TEXT_MAX-1, subtract one if text[end-1] is a high surrogate, append ellipsis.
- [ ] Verify targeted green and commit coherently.

## Task 4: Verification and delivery (item 7)

- [ ] Exhaustively rg callers and text readers; record the full 47-file list and exact added declaration delta (no new test.each).
- [ ] Through rq.sh run bun test (expected 813 tests = 807 + 6), bunx tsc --noEmit, bun run typecheck, and build:release with linux-x64 version in the same call; inspect checksums and formula. No lint script exists; start/prune are operational, not verification commands.
- [ ] Validate plugin locally with claude plugin validate plugin/; remeasure marketplace JSON and empty app status.
- [ ] Review full diff, commit, push, open the specified gh PR into main with all numbered items, red/green evidence, instrument counts and verbatim human gates. Do not merge.
- [ ] Write the dispatch's exact result.json schema in the launch directory, naming the PR and full SHAs.
