# Kairoku CLI Phase 5 — the daemon links to the app (protocol v1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, with
> superpowers:test-driven-development (bun test, red first) and
> superpowers:verification-before-completion before the PR.

**Goal:** the daemon stops being a push server and becomes a client of the Kairoku app. It
heartbeats, claims dispatches, runs them, and reports — outbound only. `POST /runs` and its inbound
bearer are deleted; the loopback listener survives for `doctor`.

**Spec:** `/Users/nihal/Work/OWDS/planning/kairoku/planned/kairoku-cli-phase5-daemon-client.md`
(READ-ONLY), ruling `DECISIONS.md` §20.1–3 and §20.9, wire spec `planned/orchestration-v1.md`.
The app half is live at `bikerwhocodes/kairoku` `a986e23b` and pinned there by
`src/lib/orchestration/dispatch-lifecycle.test.ts`; the shapes below are vendored from it.

**Stack:** unchanged — Bun + TypeScript, zero runtime dependencies, `bun test` + `tsc --noEmit`
as the merge gates.

## Global constraints

- Repo `owds-inc/kairoku`, base `main` at `f275be20`, one PR, **never merged by the builder**.
- Zero runtime dependencies (asserted by `constraints.test.ts`).
- **Exactly one module in `src/daemon/` may call `fetch`: `app.ts`**, and it may build only
  `${appUrl}/api/daemon/{heartbeat,claim,update}`. `constraints.test.ts` asserts both.
- No recipes beyond `solo`, no Agent SDK, no events channel, no environments (O-3 / O-4).
- No change to the app repo, the docs repo (O-7), or anything outside this worktree.
- **Never print a token**, in a log line, an event, a check detail or a test failure message.

## The wire, as the app answers it today

| Route | Body | Answer |
|---|---|---|
| `POST /api/daemon/heartbeat` | `{ meta?, runs?[≤50] }` | `{ daemon, liveness, heartbeatIntervalMs, runs[] }` |
| `POST /api/daemon/claim` | none | `{ dispatch: {id,targetKind,targetId,taskType,brief,createdAt} \| null }` |
| `POST /api/daemon/update` | `{ dispatchId, status, summary?, artifacts?, counts? }` | `{ ok, id, status }`, 404 not-held, 422 invalid |

`Authorization: Bearer <token>`; any auth failure is `401 {"error":"unauthorized"}`. An
`implement` run reporting `done` without all four counts is refused 422 and nothing is written.
Claim lease 300 s; liveness online ≤ 90 s, stale ≤ 300 s, offline after.

## Task 1 — config learns the app

**Files:** `src/daemon/config.ts`, `src/daemon/config.test.ts`

`Config` gains `appUrl?`, `agentToken?`, `defaultBranch`. `token` keeps its name
(`KAIROKU_DAEMON_TOKEN`) and **changes meaning**: it is the app credential, not an inbound bearer.
It becomes OPTIONAL — a daemon with no token still serves its listener and says so, because the
401 rule (item 3) requires the listener to survive a rejected token. `token.env` is parsed as a
whole env file so it can carry `KAIROKU_AGENT_TOKEN` beside it.

## Task 2 — `app.ts`, the only outbound module

**Files:** `src/daemon/app.ts`, `src/daemon/app.test.ts`, `src/daemon/testkit.ts` (`fakeApp`)

`appClient({appUrl, token, fetch?})` → `heartbeat`, `claim`, `update`. Every answer is a tagged
result: `ok`, or `unauthorized` (401) / `rejected` (other 4xx) / `server` (5xx) / `network`
(threw). The caller's whole policy hangs off that tag, so no other module reads a status code.

`fakeApp()` in the testkit is a `Bun.serve` speaking the three routes with the app's exact shapes,
including the 401 challenge, the 404-not-held answer and the counts refusal.

## Task 3 — the push API is retired (§20.3)

**Files:** `src/daemon/server.ts`, `src/daemon/runs.ts`, `src/daemon/server.test.ts`,
`src/daemon/runs.test.ts`, `src/daemon/supervision.test.ts`, `src/daemon/constraints.test.ts`

Delete `POST /runs`, `GET /runs/:id`, `POST /runs/:id/cancel`, `tokenMatches` and the bearer guard.
Keep `GET /capacity`, add `GET /status`; neither is authenticated — reachability on 127.0.0.1 is
the trust boundary, and wildcard binds stay refused. `RunStore.create(RunRequest)` and its refusal
set become `RunStore.start(StartSpec): Promise<RunResult>`: the refusals had exactly one caller and
it is being deleted. `constraints.test.ts` flips from "never calls the app" to "calls ONLY the
three app routes, and only from `app.ts`".

## Task 4 — a dispatch becomes a run

**Files:** `src/daemon/dispatch.ts`, `src/daemon/dispatch.test.ts`

`~/.kairoku/runs/<dispatchId>/run.json` `{dispatchId, state, pid, startedAt, branch, worktree}`.
`startDispatch` cuts `run/<dispatchId>` from `origin/<defaultBranch>`, injects `KAIROKU_PAT` (the
claim's run token when present, else the configured `KAIROKU_AGENT_TOKEN`), feeds the brief on
stdin, and at exit gathers `artifacts.branch`, `artifacts.prUrl` (`gh pr view` / `glab mr view`),
`artifacts.jsonl` (the local events path) and `counts` from the agent's final
`{"kairoku": {"counts": …}}` block. A claim for a repo this daemon has no checkout of is reported
`failed` with `no checkout for <repo>` — never a hang. `sweepRestarts` is the boot rule: a
non-terminal `run.json` whose pid is dead is reported `failed` "daemon restarted", **never
relaunched**.

## Task 5 — the loop

**Files:** `src/daemon/link.ts`, `src/daemon/link.test.ts`

Two timers. Heartbeat at `heartbeatIntervalMs` from the last response (30 s default) carrying
`meta {host, version, capacity}` and any report the immediate `update` could not deliver. Claim
every 5 s while `running < max` **and** the last heartbeat succeeded. Backoff on `server`/`network`
30 s → 300 s cap, reset on success. `unauthorized` stops both timers, logs once, leaves the
listener up and makes `doctor` say "app link: token rejected". A `rejected` update (404/422) marks
the run failed locally with the app's issues as the summary.

## Task 6 — wiring, `doctor`, `setup`

**Files:** `src/daemon/server.ts` (`serve()` starts the link), `src/cli/doctor.ts`,
`src/cli/setup.ts`, `src/cli/provision.ts`, and their tests

`doctor` gains an **app link** section: token present, one heartbeat 200, `protocol` echoed when
present, "runs in flight: n". The old 401/200 round trip becomes a plain reachability check.
`setup --daemon` asks for the app URL and the token (`--app-url`, `--app-token` non-interactive),
writes `token.env` 0600, and **proves the link with one heartbeat before installing the service**;
a 401 stops setup with `token not accepted by <appUrl>`. `daemonConfig` no longer mints an inbound
bearer and binds the listener to 127.0.0.1.

## Task 7 — SPEC v1

**Files:** `SPEC.md`, `README.md`

v1 replaces v0 in place; v0 is kept as an appendix marked superseded. RF ids are append-only:
RF-001/002/004 marked **retired**, RF-006 rewritten (loopback, no auth), RF-007 amended to the
"one Kairoku credential" form, RF-008 amended (distinctness moves to issuance), and RF-011 (app
link), RF-012 (the loop), RF-013 (the restart rule) added. Paseo's licence line is corrected to
Apache-2.0.

## Done-condition

Run for real on this machine against the fake app (a real app needs a browser-minted token, which
is a human gate): a daemon comes up, heartbeats, claims a queued `implement` dispatch, runs it,
reports `running` then `done` with a branch, counts and the jsonl path; killing it stops the beats.
Plus every `package.json` script with counts, `bunx tsc --noEmit`, the host release build,
`./dist/kairoku-darwin-arm64 version`, and `claude plugin validate plugin/`.
