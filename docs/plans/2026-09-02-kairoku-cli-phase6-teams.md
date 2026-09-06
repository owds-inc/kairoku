# Kairoku CLI Phase 6 — teams in the daemon (Agent SDK provider, recipes, roles, QA, events, cancel)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, with
> superpowers:test-driven-development (bun test, red first) and
> superpowers:verification-before-completion before the PR.

**Goal:** a dispatch stops being one process and becomes a **team**. The daemon resolves the
claim's `team.recipe` to a deterministic state machine, runs one member per item in its own
worktree, drives each role through a provider (Claude Agent SDK or `codex exec`), gates the work
on a reviewer verdict and a deterministic QA step, streams curated events up the heartbeat, and
obeys the beat's `cancel[]`.

**Spec:** `planned/kairoku-cli-phase6-teams.md` in the private planning workspace
(READ-ONLY), ruling `DECISIONS.md` §20.2, §20.4–8 and the grill (Q2, Q4, Q5, Q6, Q9, Q14, Q21,
Q22); wire spec `planned/orchestration-v1.md`; SDK/Codex facts `planning/orchestration-facts.md`.
The app half is live at `bikerwhocodes/kairoku` `eab363ea` — `src/lib/comms/protocol/index.ts` is
the contract these shapes are vendored from.

**Stack:** Bun + TypeScript. **One runtime dependency**, `@anthropic-ai/claude-agent-sdk`, pinned
and confined to `src/daemon/providers/claude.ts` (§20.2 amends SPEC's zero-dependency rule to name
exactly that one). `constraints.test.ts` is amended to enforce the amendment rather than the old
rule, and now recurses into `src/daemon/**` so a subdirectory cannot be an escape hatch.

## Global constraints

- Repo `owds-inc/kairoku`, base `main` at `13680cc2`, one PR, **never merged by the builder**.
- `src/daemon/app.ts` stays the only module that may call `fetch`, over the same three routes.
- No environments, no `kairoku.json` env profiles, no secrets delivery (O-4). No app change.
- No approvals-from-the-app: a denied tool is an event, never a question (§20.8).
- **Never print a token**, in a log line, a curated event, a run record or a failure message.

## Task 1 — the provider seam

**Files:** `src/daemon/providers/types.ts`, `src/daemon/policy.ts` (+ tests)

One interface: `launch(run) → { events, interrupt(), exit }`. Tool policy per role is DATA
(`POLICY`), and `decide()` is the single function both the SDK's `PreToolUse` hook and the codex
sandbox flags are derived from: implementer read/edit/write/run inside its worktree; reviewer
read + run; planner/researcher MCP + read-only. Every denial carries its reason.

## Task 2 — the two providers

**Files:** `src/daemon/providers/claude.ts`, `src/daemon/providers/codex.ts`, `src/daemon/roles/*.md`

Claude: `query()` in streaming-input mode; `cwd` = the worktree; `plugins: [{type:'local', path}]`
(NOT `settingSources`); `permissionMode` + `allowedTools` per role AND an unconditional
`PreToolUse` hook (canUseTool is last in the chain and is shadowed by bypass/allow rules);
`outputFormat: {type:'json_schema', schema}` read back from `message.structured_output`; `effort`
per role; `sessionId` recorded; `pathToClaudeCodeExecutable` = the resolved `claude`.
Codex: `codex exec --json -m <model> --output-schema <file> -o <file>`, role prompt on stdin,
sandbox from the same policy. Both are tested through an injected seam, never a live model.

## Task 3 — the QA step (no model)

**Files:** `src/daemon/qa.ts`

`kairoku.json`'s `check[]` then `test` when present, else package.json's `lint`/`build`/`test`.
One summary parser per known runner (bun, vitest, jest, go test); an unknown runner is
"counts unavailable" and the step FAILS — invariant 7 read strictly. A failure attaches the last
100 lines as the defect for the fix loop. `concurrency.test` else one machine-wide lock.

## Task 4 — the recipes

**Files:** `src/daemon/recipes.ts`

Deterministic state machines over run records, driven entirely by an injected provider:
`solo` (implementer → QA), `build-verify` (implementer → reviewer → fix loop ≤ 2 → QA → fix loop
≤ 2), `phase-team` (build-verify per item, parallel up to capacity), `plan` (planner → reviewer),
`research` (researcher → reviewer), `custom` (implementer alone). A reviewer verdict is the
structured report `{verdict, defects}`; missing or invalid fails the run CLOSED.

## Task 5 — events, cadence, cancel, restart

**Files:** `src/daemon/events.ts`, `src/daemon/runs.ts`, `src/daemon/dispatch.ts`,
`src/daemon/link.ts`, `src/daemon/models.ts`

Curated `{seq, ts, kind, text}` ≤ 2 KB, tool calls summarised, delivered values masked, full JSONL
kept locally, a bounded pending buffer (≤ 50) with an overflow line naming the drop count.
Heartbeat every 10 s while any run is active, else `heartbeatIntervalMs`. The response's `cancel[]`
interrupts a dispatch or one run. `limits.runSeconds` (default 3600) is the per-run wall clock.
`runs/<dispatchId>/<runId>.json` survives a restart; a leftover matching pid AND start time is
reaped and reported failed, never relaunched; a pending terminal report is retried until 2xx.

## Task 6 — the roles as plugin agents

**Files:** `plugin/agents/{implementer,reviewer,planner,researcher}.md`,
`plugin/.claude-plugin/plugin.json` (2.3.0), `.claude-plugin/marketplace.json`,
`plugin/skills/kairoku-mcp/SKILL.md`

`implementer.md` is rewritten for a plan item's six-section body, Jira OPTIONAL, and **never
`done`** (the app refuses it now). The kairoku-mcp skill's "human's click" table gains the Done
transition.

## Done-condition

`bun test` (pass/fail/skip/errors + file count), `bunx tsc --noEmit`, the host-target release
build and `./dist/kairoku-<host> version`, `claude plugin validate plugin/`. Plus a real run of
the daemon against the in-test fake app, end to end: a `phase-team` dispatch for three items on a
capacity-2 machine, one reviewer fix loop, one QA fix loop, a cancel of one member, and a
heartbeat advertising repos, models and recipes.
