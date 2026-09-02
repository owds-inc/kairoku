# Kairoku daemon — protocol v1

*Ratified 2026-09-02 from planning `DECISIONS.md` §20 (rulings 1–3, 9) and `planned/orchestration-v1.md`.
Build lane: `planned/kairoku-cli-phase5-daemon-client.md`; plan of record
`docs/plans/2026-09-02-kairoku-cli-phase5-daemon-client.md`. This file is the build contract; changes
to it are explicit amendments, never silent divergence. No dates, no estimates.*

**v1 SUPERSEDES v0, explicitly.** v0 is kept in full as an appendix at the bottom of this file,
marked superseded, because half a dozen documents cite its RF numbers and a reader who follows one
of those citations needs to land on the text that was true, next to the line saying it no longer is.
§19.3 of `DECISIONS.md` ("the daemon is unchanged in protocol") is superseded by §20.3.

**RF ids are append-only.** A retired requirement keeps its number and is marked retired; it is
never reused for something else.

## What changed, in one paragraph

v0's daemon was a **push server**: something on the LAN posted `POST /runs` with a brief and a
credential, behind a bearer token this daemon checked. Nothing ever built the thing that pushed.
v1 turns the daemon around. Runs are composed **in the Kairoku app**; the daemon heartbeats, polls
for work, runs it, and reports — outbound only, to one origin, over three routes. The listener
survives, unauthenticated, on loopback, so `kairoku doctor` can ask a daemon how it is doing.
`KAIROKU_DAEMON_TOKEN` keeps its name and changes meaning: it is now the credential this daemon
**presents to the app**, the one Settings → Daemons prints. Nothing converts — an old value is
simply not a token the app knows, and `doctor` says so.

## Objective

A small daemon per machine that links itself to a Kairoku app, claims dispatches composed there,
launches exactly one agent process per run in a fresh git worktree with an injected per-run
credential, supervises it to a terminal state, and reports the facts: the branch, a PR url if the
agent opened one, the four suite counts if the agent cited a suite, and where the local event log
is. It holds no state whose loss matters beyond one breadcrumb per run (RF-013). It never decides
whether work was good — the app does.

## Licence discipline

Paseo (`getpaseo/paseo`) is **Apache-2.0** and is behavioural reference ONLY. Nothing from its
codebase is copied, ported, or closely paraphrased; the API here is designed fresh. (v0 and the
docs site said AGPL-3.0. That was wrong and is corrected here — §20.10.)

## Stack

Bun + TypeScript, `Bun.serve`, **zero runtime dependencies**. In-memory run state (a `Map`) plus one
`run.json` per run on disk. Per-run JSONL event log + captured stdout (a log, not state).
`tsc --noEmit` clean and `bun test` green (with counts) are the merge gates.

## Requirements

### The app link

- **RF-011 — the app link.** `config.json` carries `appUrl` (no trailing slash; normalised on load).
  The credential is `KAIROKU_DAEMON_TOKEN` in the environment, or `token.env` beside the config
  (mode 600) — **never `config.json`**. Both come from Settings → Daemons in the app, which prints
  `KAIROKU_URL=<origin>` and `KAIROKU_DAEMON_TOKEN=<kai_…>` exactly once.
  The daemon calls **only** `POST ${appUrl}/api/daemon/{heartbeat,claim,update}`, with
  `Authorization: Bearer <token>`, from **one module** (`src/daemon/app.ts`). Both facts are
  asserted mechanically by `constraints.test.ts`, along with the refusal of any hardcoded host.
  Every answer is tagged rather than passed on as a status code — `unauthorized` (401),
  `rejected` (other 4xx), `server` (5xx), `network` (nothing answered) — because the loop's whole
  policy is a function of which of those four happened.
  Both `appUrl` and the token are OPTIONAL: an unlinked daemon starts, serves its listener, and
  says which piece is missing.

- **RF-012 — the loop.** Two timers.
  *Heartbeat*, at `heartbeatIntervalMs` from the last response (30 s default), carrying
  `meta { host, version, capacity: { running, max } }` and, in `runs`, any report `update` could not
  deliver (≤ 50, oldest first, put back untouched if the beat itself fails).
  *Claim*, every 5 s, but only while `running < max` **and** the last heartbeat succeeded — claiming
  into a link that is not working takes a dispatch off the queue that nothing will report on.
  Backoff on `server`/`network`: 30 s doubling to a 300 s cap, reset on the first success.
  **`unauthorized` stops both timers**, logs once, and leaves the listener up: `doctor` has to be
  able to walk up to a daemon whose token the app refused and be told exactly that, which it cannot
  do if the process exits. A dispatch id the daemon is already running is ignored if the app's
  lease re-issues it.

- **RF-013 — the restart rule.** Each run keeps `~/.kairoku/runs/<dispatchId>/run.json`
  `{ dispatchId, state: starting|running|done|failed, pid?, startedAt, branch, worktree? }`. On
  boot, a run left non-terminal whose pid is dead is marked failed on disk and reported to the app
  as `failed` / "daemon restarted". **It is never relaunched.** Re-running a prompt whose first
  attempt may have committed, pushed or opened a PR is worse than any stuck row; the human decides.

### Running the work

- **RF-001 — `POST /runs`. RETIRED (§20.3).** Runs start in the app. The route, its refusal
  vocabulary (`capacity_full` · `unknown_role` · `missing_credential` · `duplicate_credential` ·
  `empty_brief`) and the refusal-not-queueing rule are all deleted. Capacity is now a gate on
  *claiming*, not a refusal to a caller.
- **RF-002 — `GET /runs/{id}`. RETIRED (§20.3).** The app is the ledger; `GET /status` lists what is
  in flight for `doctor`.
- **RF-003 — events**: per-run JSONL at `~/.kairoku/runs/<dispatchId>/events.jsonl` (created,
  started, finished, teardown, error) plus `stdout.log`. Its path travels to the app as
  `artifacts.jsonl`; the file stays the source of truth. Curated events over the heartbeat are O-3.
- **RF-004 — `POST /runs/{id}/cancel`. RETIRED (§20.3)** as a route. The group-kill and teardown it
  drove remain and are what daemon shutdown uses; cancellation *from the app* (the heartbeat's
  `cancel` list) arrives in O-3.
- **RF-005 — `GET /capacity`** → `{ running, max }` (max from config). Unauthenticated, loopback.
- **RF-006 — the bind is the boundary.** The listener has **no inbound credential**: with the push
  API retired it answers `doctor` and nothing else, so reachability on the configured address is the
  trust boundary. It therefore binds **127.0.0.1** by default and **refuses `0.0.0.0`, `::` and an
  empty host outright** — an unauthenticated surface on a LAN address would be a different bargain,
  and `kairoku setup --daemon` pulls a config left on a LAN address from the push-API days back to
  loopback. `GET /status` → `{ version, capacity, link, runs }` is what `doctor` reads.
- **RF-007 — AMENDED.** v0: "the runner never talks to Kairoku, Jira or GitHub." v1: **one Kairoku
  credential, scoped to the heartbeat and queue endpoints, and nothing else.** The daemon still
  holds no Jira, forge or MCP credential of its own; every claim about the *content* of work still
  comes from the agents it launches, under their own identity. What it reports is only what it can
  observe from outside: an exit status, a branch, a PR url it looked up, counts the agent printed.
- **RF-008 — AMENDED.** v0 refused a `POST /runs` whose `KAIROKU_PAT` hashed to a running run's.
  With no inbound caller there is nothing to refuse, and **distinctness moves to issuance**: the app
  mints one `mcp_tokens` row per run at claim (`run:<dispatchId>:<runId>`) and revokes it at the
  terminal update. Until that lands (O-2), a run whose claim carries no run token falls back to the
  configured `KAIROKU_AGENT_TOKEN` in `token.env` — **a single shared identity, recorded here as the
  known gap**, removed in O-3. A run with neither is reported `failed` rather than launched without
  a credential. Unchanged: a credential value never appears in a log, an event, a run record or an
  error.
- **RF-009 — roles are a fixed table in the daemon**: `executor` only — provider `codex`, command
  `codex exec --json`, `approval_policy: "never"`, `sandbox_mode: "workspace-write"`. Command
  construction lives in one module; tests substitute a stub through test-only config, never a
  test-mode role. Claude Code arrives in O-3 through the Agent SDK, with §20.8's per-role tool
  policy; a half-provider added here would be replaced by that.
- **RF-010 — teardown on every exit path**: normal exit, timeout (default 3600 s, per-run override),
  cancel, and daemon shutdown (SIGTERM kills children, marks running runs, writes final events).
  Agent processes spawn in their own process group; kill is group-wide (no orphans). Worktree
  teardown runs unless the run failed and `keepWorktreeOnFailure` is set.

## A dispatch becomes a run

`solo` recipe only (the recipe table is O-3). One claim → one worktree `run/<dispatchId>` cut from
`origin/<defaultBranch>` in the configured checkout, `bun install`, `.env*` copied from the base
checkout. `KAIROKU_PAT` = the claim's run token, else `KAIROKU_AGENT_TOKEN` (RF-008). The brief goes
in on **stdin** — never argv, so it stays out of the process table and a brief beginning with `-` is
not read as a flag. `update running` at launch; at exit, `update done|failed` with
`artifacts.branch`, `artifacts.prUrl` (`gh pr view` / `glab mr view` on the branch, asked of the base
checkout because the worktree is gone by then), `artifacts.jsonl`, and `counts` parsed from the
agent's final `{"kairoku": {"counts": {…}}}` block when it printed one.

**§20.9 — one checkout per daemon.** A claim naming a repo this daemon has no checkout of is
reported `failed` with `no checkout for <owner/name>`, immediately. Never a hang, never an attempt.
A repo map with auto-clone is the follow-up.

**The daemon reports facts; the app decides.** A `422` from `update` (invariant 7: an `implement`
run cannot report `done` without all four counts) is logged, the run marked failed locally with the
app's own issues, and **not retried into the same refusal**. A `404` (a dispatch this daemon does not
hold) is treated the same way.

## Worktree module

`git fetch origin` then `git worktree add -b run/<dispatchId> <worktreesDir>/<dispatchId>
origin/<defaultBranch>` against the configured base checkout. Setup before the agent starts:
`bun install` + copy the base checkout's `.env*`. Teardown per RF-010, keeping the branch: the run's
commits are the deliverable. Stale worktrees from a dead daemon are cleaned only by the human-run
`kairoku daemon prune` (enumerate via `git worktree list` + the `run/` branch prefix; print,
confirm, remove) — never an automatic sweep.

## Config

`~/.kairoku/config.json` (`KAIROKU_DAEMON_CONFIG` overrides the path): `{ listen, appUrl,
defaultBranch, maxConcurrent, repoPath, repoUrl?, worktreesDir?, runsDir?, keepWorktreeOnFailure?,
defaultTimeoutSec?, killGraceMs? }`. Credentials via `KAIROKU_DAEMON_TOKEN` /
`KAIROKU_AGENT_TOKEN` in the environment or `~/.kairoku/token.env` (mode 600), never config.json.
`~/.hikyaku/`, `HIKYAKU_TOKEN` and `HIKYAKU_CONFIG` are honoured for one version with a deprecation
line and a one-time copy of the directory.

## v1 exit criterion (the done-condition)

A daemon set up with a token minted in Settings → Daemons appears there **online within a minute**,
claims a queued `implement` dispatch composed on a plan item, runs it, and the run shows a branch and
(if the agent opened one) a PR url; killing the daemon turns it stale then offline on the app's
clock. Plus: the full `bun test` suite green **with counts reported**, `tsc --noEmit` clean, and
tests covering the beat cadence, the capacity gate, the double-claim guard, the 401 stop, the
backoff, the report contents, the restart rule, the constraint pins, and setup's proving heartbeat.

## Deliberately out of v1 (each is a named lane)

Recipes beyond `solo`, the Agent SDK provider and the four plugin agents, the per-role tool policy,
curated events over the heartbeat, cancel from the app (all **O-3**) · `kairoku.json`, environments,
compose per run, secrets client-side (**O-4**) · per-run MCP tokens and the runs/events tables
(**O-2**) · live terminal attach/steering · scheduling · providers beyond two · any auto-approval of
agent permission requests (no trigger — this is a gate, not a backlog item).

---

# Appendix — protocol v0 (SUPERSEDED by v1 above, 2026-09-02)

*Kept verbatim because other documents cite its RF numbers. **Nothing in this appendix is current.**
Where v1 keeps a requirement it says so above; where it retired one, the retirement is recorded
above under the same number.*

*Frozen 2026-08-27 from `kairoku-plan/orch/runner-spec-seed.md` + `orch/PLAN.md` (decision C,
ratified by Neil). The evidence base is `orch/dispatch-layer-research.md`.*

*Amended 2026-09-02 (planning `DECISIONS.md` §19, `docs/plans/2026-09-02-kairoku-cli-v0.1.md`): retitled
for the Kairoku CLI repo; the config dir is `~/.kairoku/`, the token env `KAIROKU_DAEMON_TOKEN` (or
`token.env` beside the config), the services `kairoku-daemon` (systemd) / `io.kairoku.daemon` (launchd),
the cleanup CLI `kairoku daemon prune`.*

## v0 Objective

A small daemon per VM that accepts a run request — role, provider, brief, worktree parameters,
env — launches exactly one agent process for it in a fresh git worktree with an injected per-slot
credential, supervises it to a terminal state, and answers capacity questions. It holds no state
whose loss matters: the ledger (in the Kairoku app) owns recovery. It reports nothing itself —
every claim about work arrives from the agents it launches, through the existing protocol, under
their own credentials.

## v0 Requirements

- **RF-001 — `POST /runs`** with
  `{ role, provider?, model?, brief, repo?, worktree?: { base? }, env, labels?, timeoutSec? }`
  → `201 { runId }`. **Refuses** (4xx with a named `reason`, never a queue):
  `capacity_full` · `unknown_role` · `missing_credential` (env lacks a non-empty `KAIROKU_PAT`) ·
  `duplicate_credential` (RF-008) · `empty_brief`. Refusal-not-queueing keeps v0 stateless.
- **RF-002 — `GET /runs/{id}`** →
  `{ status: "running"|"idle"|"error"|"timeout", startedAt, branch, exitSummary? }`.
- **RF-003 — events**: per-run JSONL at `~/.kairoku/runs/<runId>/events.jsonl` plus `stdout.log`.
- **RF-004 — `POST /runs/{id}/cancel`** — kills the process **group**, runs teardown, marks
  `error` with `exitSummary: "cancelled"`.
- **RF-005 — `GET /capacity`** → `{ running, max }` (max from config).
- **RF-006 — auth**: one bearer token per daemon (`KAIROKU_DAEMON_TOKEN` env, or `token.env` beside
  the config file, never config.json), checked on every request with a constant-time compare;
  listener binds only to the configured host (the VM's LAN IP), never `0.0.0.0`.
- **RF-007 — the runner never talks to Kairoku, Jira, or GitHub.** It holds no credentials for
  them by construction; only the agents it launches do.
- **RF-008 — credential distinctness enforced mechanically**: `POST /runs` refuses when the
  SHA-256 of the offered `KAIROKU_PAT` equals that of any currently running run's.
- **RF-009 — roles are a fixed table in the daemon**: v0 ships `executor` only.
- **RF-010 — teardown on every exit path.**

## v0 exit criterion

Two runs dispatched concurrently complete with two distinct credential identities visible in the
Kairoku ledger, each run's branch checkable from its entry alone. Plus the full suite green with
counts, `tsc --noEmit` clean, and supervision tests covering orphan reaping on cancel, teardown on
timeout, teardown on daemon SIGTERM, refusal of a duplicate credential, refusal past capacity.
