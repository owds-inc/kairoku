# Code intelligence v1 (CI-1) — rules from the base branch, blocked at the write and failed in QA

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, with
> superpowers:test-driven-development (bun test, red first) and
> superpowers:verification-before-completion before the PR.

**Goal:** a repo states its own code-shape rules once, on its base branch, and every run of it is
held to them twice — at the write, where the agent can still fix it cheaply, and in QA, which is the
gate of record. Plus the two smaller pieces of the same ruling: Codex reaches parity with Claude on
the hook and stops inheriting a machine-wide MCP credential, and a TypeScript repo gets a language
server so an implementer can resolve a symbol instead of grepping for it.

**Spec:** `planned/code-intelligence-1.md` in the private planning workspace (READ-ONLY),
ruling `DECISIONS.md` §21 (Q1–Q29). Facts: `planning/orchestration-facts.md` (the SDK hook shape),
`planning/code-intelligence/sources/codex-surfaces.md` (Codex config/hooks/MCP),
`planning/code-intelligence/sources/defect-classes.md` (the three rules and the defects behind them).

**Stack:** unchanged. Bun + TypeScript, **one runtime dependency**
(`@anthropic-ai/claude-agent-sdk`, confined to `providers/claude.ts`). ast-grep is a BINARY on
PATH, never an import — `constraints.test.ts` still pins the dependency list to one entry.

## Global constraints

- Repo `owds-inc/kairoku`, base `main` at `629f6be4`, one PR, **never merged by the builder**.
- `src/daemon/app.ts` stays the only module that may call `fetch`.
- No CodeGraph (CI-2), no app change (CI-3), no docs-repo change, **no rule shipped by the plugin**.
- Never print a token. The per-run Codex MCP entry names an ENV VAR, never a value.

## Task 1 — the rules, read from the base branch (`src/daemon/rules.ts`)

`.kairoku/rules/*.yml` in the TARGET repo, ast-grep's own rule format, read with
`git ls-tree` + `git show` against `origin/<defaultBranch>` exactly as `manifest.ts` reads
`kairoku.json` — never the worktree, so a run cannot disable a rule in its own PR. Materialised
once per dispatch into `<runsDir>/<dispatchId>/rules/`, as `rules/<name>.yml` plus an
`sgconfig.yml` that points at them (ast-grep's `-r` takes one file; a directory needs a config).

No rules on the base branch → `{ ok: true }` with no `rules`, and nothing downstream runs.
Rules but no `ast-grep` on this machine → `{ ok: false }` naming ast-grep, which fails the run
closed at environment settlement, the way a missing secret resolver does.

`scanRules()` shells out to the RESOLVED ast-grep path (rule 3's own lesson) with
`scan -c <sgconfig> --json=compact <paths>` and parses the array. Unreadable output is
`{ ok: false }`, never "no matches".

## Task 2 — layer one, the hook at the write (`providers/claude.ts`)

A `PostToolUse` hook on `Write|Edit` beside the unconditional `PreToolUse` policy hook, in the same
`hooks` option. On a match it returns the SDK's blocking result (`decision: "block"` with `reason`),
carrying each rule's `message` and its `note` — the defect the rule exists for. Files outside the
worktree are ignored (`insideWorktree`, exported from `policy.ts` rather than written twice), and so
is anything ast-grep does not parse, because a language it has no rule for simply yields no match.
One shell-out per write; no daemon-side parsing of the file.

## Task 3 — layer two, QA (`qa.ts`)

Whenever rules were materialised, `runQa` scans the whole worktree BEFORE the manifest's `check`
commands. Any match fails QA with the rule ids and `file:line` in the defect text the fix loop is
handed. No manifest entry; this is automatic (§21's lead ruling).

## Task 4 — Codex parity (`providers/codex.ts`)

Written fresh per run into the worktree and excluded from the diff:

- `.codex/config.toml` — `[mcp_servers.kairoku]` with `bearer_token_env_var = "KAIROKU_PAT"` and
  `default_tools_approval_mode = "approve"`, the url built from the run's own `KAIROKU_URL`.
- `.codex/hooks.json` — a `PostToolUse` matcher `Write|Edit` running the materialised scan script.

Trust is a SESSION FLAG, not a file: `-c projects."<worktree>".trust_level="trusted"` makes the
project layer load, and `--dangerously-bypass-hook-trust` lets a hook the daemon itself just wrote
run unattended. Both are per-invocation and leave nothing on the machine.

## Task 4b — the machine-wide Codex MCP credential moves into the run

`provision.ts` stops adding `--bearer-token-env-var KAIROKU_PAT` machine-wide (interactive Codex on
the same machine never has `KAIROKU_PAT` set, and Codex prefers the bearer path once it is
configured — `401 No authorization provided`). `codex mcp add … --url …` then `codex mcp login
kairoku` (OAuth). `doctor` flips from "writes pre-approved" to "the global entry carries no bearer".

## Task 5 — exact resolution (LSP)

`kairoku setup --daemon` installs `typescript-language-server` and `typescript` globally through bun
when the configured checkout has a `tsconfig.json`. `doctor` reports absence as **WARN**, never
FAIL. Claude Code's built-in LSP tool finds the server on PATH; the Claude provider needs no change
and Codex gets nothing here.

## Task 6 — the `patterns.md` convention

One instruction each in `plugin/agents/implementer.md`, `plugin/agents/reviewer.md` and
`src/daemon/roles/*.md`: read `AGENTS.md`/`CLAUDE.md` and `.kairoku/patterns.md` before the first
write; a change to `.kairoku/patterns.md` is allowed only inside the run's own item scope, and the
reviewer treats any other change to it as a defect. No injection machinery.

## Task 7 — the surfaces

Plugin `2.4.0`; SPEC gains **RF-021**; README's "A run's environment" gains the rules paragraph;
`doctor` gains three lines — ast-grep, typescript-language-server, and the count of rules on the
configured repo's base branch.

## Task 8 — dogfood

This repo gets `.kairoku/rules/bun-spawn-resolved-path.yml` (rule 3, citing CLI PR #7 defect 5), a
matching `ast-grep test` fixture, a root `sgconfig.yml`, and a `kairoku.json` whose `check`/`test`
are this repo's own scripts — so a Kairoku daemon can run this repo's own items.
