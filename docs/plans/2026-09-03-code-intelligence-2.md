# Code intelligence v1 (CI-2) — CodeGraph on probation, opt-in per repo

**Goal:** a repo that wants it asks for CodeGraph once, in `kairoku.json`; when it has, every run of
that repo gets its own worktree indexed before the first role turn and a read-only MCP server
pointed at that index, on both hosts, and the two numbers §21's measurement compares ride along on
every run whether the index was built or not. It degrades silently rather than failing — a
probation, not a dependency.

**Spec:** `planned/code-intelligence-2.md` in the private planning workspace (READ-ONLY),
ruling `DECISIONS.md` §21 (Q2, Q4, Q15, Q19). Facts:
`planning/code-intelligence/sources/local-baseline.md` (CodeGraph's CLI, MCP and library surface)
and `sources/gap-3-per-worktree-index-cost-and-linux-footprint.md` (no index sharing across
worktrees).

**Base:** `856035b225354fa4e127b37e3c58012360a102ad` — `origin/main` with CI-1 (#10) merged, which
this lane waited on: it shares `manifest.ts`, `policy.ts` and the Codex per-run config writer.
**Branch:** `daemon/codegraph`. **Head:** `d785f8ac70d4381a90f0bc35fd222a83ab21cdd6`.

## What was built

### 1. Opt-in through the manifest

`kairoku.json` gains `intelligence: ["codegraph"]` — `src/daemon/manifest.ts` (`INTELLIGENCE`,
`Intelligence`, `Manifest.intelligence`, the value check inside `parseManifest`). Absent or empty
is the default and changes nothing. An entry the daemon does not know is REFUSED with its JSON
path, not ignored: `kairoku.json: intelligence[1] is not one of: codegraph`.

### 2. Per run, when it is on: index, then hand it over as an MCP server

`src/daemon/codegraph.ts` (new) — `indexWorktree`, `codegraphMcpServers`, `codegraphTomlTable`,
`CODEGRAPH_NOTE`. `src/daemon/dispatch.ts` runs the index after the worktree is cut and before the
first role turn, only when the base branch's manifest opted in, and records the event.
`providers/claude.ts` adds `mcpServers` to the SDK query options; `providers/codex.ts` appends
`[mcp_servers.codegraph]` to the per-run `.codex/config.toml` CI-1 already writes. `policy.ts` gains
`CODEGRAPH_MCP_PREFIX` (`mcp__codegraph__`) as a second, read-only server prefix — a third prefix is
still denied. `roles/index.ts`'s `withRoleContract` takes an optional extra sentence, given only on
a run that actually has the index.

The index command and file count were read from the installed binary, not from memory:
`codegraph init <worktree>`, then `codegraph status --json`'s `fileCount` — never a regex over
`init`'s ANSI progress output, which is a line that breaks on the next release. One index per
worktree, pinned with `-p`, because CodeGraph refuses to share a `.codegraph` across git worktrees
(its own issues #155/#1236) — N concurrent members pay N cold indexes, which is exactly what Q4
measures. `.codegraph/` is excluded from the run's git through the checkout's common
`info/exclude`, the same helper `.codex/` already used, moved into `worktree.ts` so the two callers
share one walk rather than a second copy drifting.

### 3. Degrade silently

`codegraph.ts`: no binary on PATH → `{}`, nothing runs, no event, no failure; a failed or
unspawnable index → no server, one honest `not indexed — <reason>` line, still no failure.
`doctor.ts` gains one `codegraph` check, PASS with the version or WARN naming the absence — never
FAIL, which is the line between this and RF-021's rules: a rule nobody checked is a false clean
report, an index nobody built is only a slower agent.

### 4. Instrument for §21 Q19

`events.ts` gains `EventBuffer.tools()`, counting tool calls on the way in (not from what is still
pending — the wire buffer drops its oldest lines, and pending answers a different question). At the
end of the member's own work — before the teardown and PR-lookup tail, which is daemon time, not
agent time — `dispatch.ts` pushes one curated event, `run: <n> tool calls in <s>s`, and records the
same two numbers as `measure` on the run's own state file. Recorded on every run, indexed or not: a
measurement needs both arms. No app change — both ride the existing `events[]` text.

### 5. Tests, red-first

Every behaviour above has a test that failed before the code that made it pass; no test invokes
real CodeGraph (`which`/`exec` are seams, as `rules.ts` already does it), and `doctor`'s line is fed
by the fake `io`.

## Red, then green

**Manifest parsing of `intelligence`**
```
(fail) parseManifest > an invalid manifest fails with the PATH of the error: "{\"intelligence\":\"codegraph\"}"
(fail) parseManifest > an invalid manifest fails with the PATH of the error: "{\"intelligence\":[1]}"
(fail) §21 Q15 … > a repo opts CodeGraph in by naming it
(fail) §21 Q15 … > absent, or empty, means nothing changes — the flag is opt-in and off is the default
(fail) §21 Q15 … > an intelligence this daemon does not know is REFUSED, with its JSON path
 21 pass / 6 fail
```
→ `27 pass, 0 fail` after `manifest.ts`.

**The index step running, recorded, silent when the binary is missing**
```
error: Cannot find module './codegraph' from '…/src/daemon/codegraph.test.ts'
 0 pass / 1 fail / 1 error
```
→ `13 pass, 0 fail` after `codegraph.ts` (event line, resolved path, silent degrade, a failed
index, an unreadable status, an unspawnable binary, the `.codegraph/` exclusion against a real
linked worktree, and the two MCP shapes).

**The Claude `mcpServers` option and the Codex table**
```
(fail) claude — §21 CodeGraph as an MCP server for the run > an indexed run gets the server, pinned to its own worktree
(fail) claude — §21 CodeGraph as an MCP server for the run > the tool is named in the prompt only when it is actually there
(fail) codex — §21 CodeGraph as an MCP server for the run > an indexed run gets the codegraph table, pinned to its own worktree
 56 pass / 3 fail
```
→ `77 pass, 0 fail` across `src/daemon/providers/`.

**The policy prefix**
```
(fail) policy — the matrix (§20.8, fail closed) > §21 — every role may query CodeGraph, and only CodeGraph's own tools
 12 pass / 1 fail
```
→ `13 pass, 0 fail`.

**The index in a real dispatch, and the end-of-run numbers**
```
(fail) dispatch — §21 CodeGraph, opt-in per repo > the flag ON indexes the worktree BEFORE the first role turn, and every turn gets the index
(fail) dispatch — §21 CodeGraph, opt-in per repo > the index step is recorded as ONE event line carrying the file count and the wall clock
(fail) dispatch — §21 Q19 … > the end-of-run event carries the tool calls and the wall clock
(fail) dispatch — §21 Q19 … > the same two numbers are on the run's own record, for a post-mortem with no app
 55 pass / 4 fail
```
→ `59 pass, 0 fail`.

**The doctor line**
```
(fail) kairoku doctor > a provisioned linux VM passes every check
(fail) §21 — doctor's three new lines > §21 item 3 — codegraph absent is a WARN, never a FAIL: the probation degrades, it does not block
 25 pass / 2 fail
```
→ `27 pass, 0 fail`.

## The surfaces (documentation round 1)

SPEC.md gains **RF-022** and a top-of-file amendment paragraph, newest first, above the §21/RF-021
paragraph; README's "A run's environment" gains the `intelligence` key and its one sentence, and
the doctor sample gains the `codegraph` line. This document. No source or test change in this
round — the code round's instruments (below) are unchanged by it.

## Not built, and why

1. **A distinct event kind for the index (`kind: "index"`).** The brief's text asked for it; the
   app's own wire vocabulary (`app.ts:59`, `"text" | "tool" | "ok" | "deny" | "error"`) is pinned
   and this lane's Boundary forbids an app change. Shipped as `kind: "ok"` with the exact text
   `codegraph: <n> files in <s>s` instead — nothing is lost but the label. A one-line app-side
   widening plus one line here if the distinct kind is wanted.
2. **`kairoku setup --daemon` provisioning `codegraph`.** §21 provisions `ast-grep` (RF-021, a gate)
   and `typescript-language-server` by name; CodeGraph is on probation, and installing it by default
   would commit the machine to a thing that has not passed its trial before the measurement is run.
   `doctor` names the absence instead.
3. **This repo's own `kairoku.json` opting in.** Q4/Q26 put the measurement on the app repo's real
   plan items (CI-3 turns the flag on there); opting the CLI repo itself in would put an unmeasured
   index on its own runs for no comparison anyone is running.
4. **Anything that tears down a CodeGraph process.** Checked with `ps` rather than assumed:
   `codegraph init` leaves no background process, and `codegraph serve --mcp` is a child of the MCP
   client whose own watchdog exits on a broken stdin pipe — a worktree removed at teardown strands
   nothing.

## The instruments, with counts, at `d785f8a` (code round; documentation round unchanged)

| Instrument | Result |
|---|---|
| `bun test` | 615 pass · 0 fail · 0 skip · 0 errors, "Ran 615 tests across 38 files" |
| `bunx tsc --noEmit` | clean, no output |
| `bun run build:release` | four targets compiled |
| `./dist/kairoku-<host> version` | `kairoku 0.1.0` |
| `./dist/kairoku-<host> doctor` | the `codegraph` line PASSes with the binary present and WARNs
  without it |
| `claude plugin validate plugin/` | passed |

**Test delta, reconciled.** `615 = 586 base + 29`: 27 new `test(`/`test.each(` lines plus 2 rows
appended to an existing `test.each` array in `manifest.test.ts`. Files: `38 = 37 base + 1`
(`src/daemon/codegraph.test.ts`).

## Human gates (Neil's, not the builder's)

1. Merging this PR.
2. Turning the `intelligence` flag on for the app repo (CI-3, a separate lane).
3. The Q4/Q19/Q26 measurement itself: three real plan items of similar size, two runs each way,
   CodeGraph stays only with fewer tool calls or less wall clock per item at equal-or-better QA
   counts. This lane ships the instruments for it, not the verdict.
