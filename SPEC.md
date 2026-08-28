# hikyaku (飛脚) — dispatch runner, spec v0

*Frozen 2026-08-27 from `kairoku-plan/orch/runner-spec-seed.md` + `orch/PLAN.md` (decision C,
ratified by Neil). The evidence base is `orch/dispatch-layer-research.md`. This file is the build
contract for v0; changes to it are explicit amendments, never silent divergence. No dates, no
estimates.*

## Objective

A small daemon per VM that accepts a run request — role, provider, brief, worktree parameters,
env — launches exactly one agent process for it in a fresh git worktree with an injected per-slot
credential, supervises it to a terminal state, and answers capacity questions. It holds no state
whose loss matters: the ledger (in the Kairoku app) owns recovery. It reports nothing itself —
every claim about work arrives from the agents it launches, through the existing protocol, under
their own credentials.

## License discipline

Paseo (AGPL-3.0) is behavioral reference ONLY. Nothing from its codebase is copied, ported, or
closely paraphrased. The API here is designed fresh. This keeps hikyaku MIT-or-proprietary and
product-embeddable.

## Stack

Bun + TypeScript, `Bun.serve`, **zero runtime dependencies**. In-memory state only (a `Map` of
runs) — no database by design. Per-run JSONL event log + captured stdout on disk (a log, not
state). `tsc --noEmit` clean and `bun test` green (with counts) are the merge gates.

## Requirements

- **RF-001 — `POST /runs`** with
  `{ role, provider?, model?, brief, repo?, worktree?: { base? }, env, labels?, timeoutSec? }`
  → `201 { runId }`. **Refuses** (4xx with a named `reason`, never a queue):
  `capacity_full` · `unknown_role` · `missing_credential` (env lacks a non-empty `KAIROKU_PAT`) ·
  `duplicate_credential` (RF-008) · `empty_brief`. Refusal-not-queueing keeps v0 stateless.
- **RF-002 — `GET /runs/{id}`** →
  `{ status: "running"|"idle"|"error"|"timeout", startedAt, branch, exitSummary? }`.
  (`blocked` is reserved in the vocabulary but unreachable in v0: `codex exec` with
  `approval_policy: "never"` never parks. Do not fabricate it.)
- **RF-003 — events**: per-run JSONL at `~/.hikyaku/runs/<runId>/events.jsonl` (created, started,
  finished, teardown, error) plus `stdout.log`. Coarse transitions are enough; no SSE in v0.
- **RF-004 — `POST /runs/{id}/cancel`** — kills the process **group**, runs teardown, marks
  `error` with `exitSummary: "cancelled"`.
- **RF-005 — `GET /capacity`** → `{ running, max }` (max from config).
- **RF-006 — auth**: one bearer token per daemon (from `HIKYAKU_TOKEN` env or config), checked on
  every request with a constant-time compare; listener binds only to the configured host (the
  VM's LAN IP), never `0.0.0.0`. No TLS inside the LAN; a reverse proxy adds it if ever needed.
- **RF-007 — the runner never talks to Kairoku, Jira, or GitHub.** It holds no credentials for
  them by construction; only the agents it launches do. It writes no ledger entries, no statuses,
  no comments — the injected env and the agent's own tooling do all reporting.
- **RF-008 — credential distinctness enforced mechanically**: `POST /runs` refuses when the
  SHA-256 of the offered `KAIROKU_PAT` equals that of any currently running run's. Hashes only —
  the token value never appears in logs, events, errors, or run records.
- **RF-009 — roles are a fixed table in the daemon**: v0 ships `executor` only — provider
  `codex`, command `codex exec --json`, `approval_policy: "never"`,
  `sandbox_mode: "workspace-write"`. An undeclared role is `unknown_role`. The role's command
  construction lives in one module; tests substitute a stub command through test-only config,
  never a test-mode role.
- **RF-010 — teardown on every exit path**: normal exit, timeout (default 3600s, per-run
  `timeoutSec` override), cancel, and daemon shutdown (SIGTERM handler kills children, marks
  running runs `error`/`daemon-shutdown`, writes final events). Agent processes spawn in their
  own process group; kill is group-wide (no orphans). Worktree teardown runs unless the run
  failed and `keepWorktreeOnFailure` is set (post-mortem opt-out).

## Worktree module

`git fetch origin` then `git worktree add -b run/<runId> <worktreesDir>/<runId> origin/main`
against the configured base checkout (`~/work/kairoku` by default). Setup before the agent
starts: `bun install` + copy `.env*` from the base checkout. Teardown per RF-010. Stale worktrees
from a dead daemon are cleaned only by the human-run `hikyaku prune` CLI (enumerate via
`git worktree list` + the `run/` branch prefix; print, confirm, remove) — never an automatic
sweep.

## Config

`~/.hikyaku/config.json`: `{ listen, maxConcurrent, repoPath, worktreesDir?,
keepWorktreeOnFailure? }`. Token via `HIKYAKU_TOKEN` env (systemd unit), not the file.

## v0 exit criterion (the done-condition)

Two runs dispatched concurrently (curl is fine) complete with **two distinct credential
identities visible in the Kairoku ledger**, each run's branch checkable from its entry alone.
Plus: the full `bun test` suite green **with counts reported**, `tsc --noEmit` clean, and
supervision tests covering: orphan reaping on cancel, teardown on timeout, teardown on daemon
SIGTERM, refusal of a duplicate credential, refusal past capacity.

## Deliberately out of v0 (triggers recorded in orch/PLAN.md)

Live terminal attach/steering · queueing · Claude backend (v0.1) · reviewer role (v0.1) · SSE
(v0.1) · `RunnerAdapter` in the Kairoku app (v0.2, gated) · scheduling · providers beyond two ·
any auto-approval of agent permission requests (no trigger — this is a gate, not a backlog item).
