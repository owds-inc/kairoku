# Kairoku CLI

`kairoku` is one binary that sets up everything a developer laptop or an
agent VM needs to work with [Kairoku](https://kairoku.io): the Claude Code
plugin, and the orchestration daemon that runs agents in fresh git worktrees.

## Install

From the first tagged release (`v0.1.0`, pending):

```sh
brew install owds-inc/tap/kairoku                                                    # mac
curl -fsSL https://raw.githubusercontent.com/owds-inc/kairoku/main/install.sh | sh   # mac / linux
kairoku setup                                                                        # wizard: plugin and/or daemon
```

`kairoku setup --plugin`, `--daemon` or `--all` (add `--yes` to skip the
prompts) run the chosen steps without the wizard. `kairoku doctor` verifies a
machine and changes nothing; `kairoku update` replaces the binary with the
latest release (brew users: `brew upgrade kairoku`). `kairoku version`.

## The plugin

`plugin/` is the Claude Code plugin: Kairoku's MCP tools over OAuth (no pasted
tokens), the jira-ops / git-pr / kairoku-mcp protocol skills, and the
implementer agent. `kairoku setup --plugin` runs the two commands below; they
also work by hand inside Claude Code:

```
/plugin marketplace add owds-inc/kairoku
/plugin install kairoku@kairoku-marketplace
```

From a checkout: `claude plugin marketplace add /path/to/kairoku`, then the
same install line. Plugin releases are tagged `kairoku--v<version>`.

## The daemon

One daemon per VM: it accepts a run request, cuts a fresh git worktree,
launches exactly one agent process in it under an injected per-slot
credential, supervises that process to a terminal state, and answers capacity
questions. It holds no state whose loss matters — the ledger in the Kairoku
app owns recovery — and it reports nothing itself. Every claim about work
comes from the agents it launches, under their own credentials.

**`SPEC.md` is the build contract.** Changes to behaviour are amendments
there, never silent divergence here.

`kairoku daemon` (foreground) and `kairoku daemon install|start|stop|status`
(launchd on mac, systemd on linux) arrive with Phase 3 of
`docs/plans/2026-09-02-kairoku-cli-v0.1.md`. Until then the daemon runs from
source and a VM is provisioned by the bash `./hikyaku` script (`./hikyaku
setup`, `./hikyaku doctor` — see its header), which that phase deletes:

```sh
bun install
HIKYAKU_TOKEN=… bun run start          # or: HIKYAKU_CONFIG=/path/to/config.json
```

Config — `~/.hikyaku/config.json` today, `~/.kairoku/config.json` with
`KAIROKU_DAEMON_TOKEN` from Phase 3 (migrated once, automatically). All keys
optional:

```json
{
  "listen": { "host": "192.168.23.167", "port": 7801 },
  "maxConcurrent": 2,
  "repoPath": "/home/neil/work/kairoku",
  "worktreesDir": "/home/neil/.hikyaku/worktrees",
  "runsDir": "/home/neil/.hikyaku/runs",
  "keepWorktreeOnFailure": false,
  "defaultTimeoutSec": 3600,
  "killGraceMs": 5000
}
```

The bearer token is **not** in the file: it comes from the environment (the
service unit). The listener refuses to bind `0.0.0.0` (RF-006).

### API

Every route requires `Authorization: Bearer <token>`.

| Route | Answer |
|---|---|
| `POST /runs` | `201 {runId}`, or a 4xx naming one refusal |
| `GET /runs/{id}` | `{status, startedAt, branch, exitSummary?}` |
| `POST /runs/{id}/cancel` | kills the process group, tears down, `error`/`cancelled` |
| `GET /capacity` | `{running, max}` |

`POST /runs` body: `{role, provider?, model?, brief, repo?, worktree?: {base?}, env, labels?, timeoutSec?}`.

Refusals — never a queue: `capacity_full` (429) · `duplicate_credential` (409) ·
`unknown_role` · `missing_credential` · `empty_brief` (400). Statuses are
`running | idle | error | timeout`; `blocked` is reserved but unreachable in v0.

```sh
curl -sX POST http://192.168.23.167:7801/runs \
  -H "authorization: Bearer $HIKYAKU_TOKEN" -H 'content-type: application/json' \
  -d '{"role":"executor","brief":"…","env":{"KAIROKU_PAT":"…"}}'
```

## Working on it

```sh
bun test                          # the suite — counts are the merge gate
bun run typecheck                 # tsc --noEmit — bun test never type-checks
bun run src/cli/main.ts version   # the CLI from source
bun run prune                     # human-run worktree cleanup; asks first
```

| Path | Holds |
|---|---|
| `src/cli/main.ts` | the CLI entry: dispatch, `version` (the rest lands in Phase 2) |
| `src/daemon/server.ts` | routes, bearer auth, the bind, SIGTERM wiring |
| `src/daemon/runs.ts` | the run `Map`, the refusal set, lifecycle, teardown policy |
| `src/daemon/roles.ts` | the fixed role table — the only place a command line is built |
| `src/daemon/proc.ts` | process-group spawn, timeout, group kill, escalation |
| `src/daemon/worktree.ts` | `git worktree` create/teardown, `.env*` seeding, enumeration |
| `src/daemon/events.ts` | per-run JSONL + stdout capture |
| `src/daemon/config.ts` | config file, env token, bind validation |
| `src/daemon/prune.ts` | the human-run cleanup CLI |
| `plugin/`, `.claude-plugin/` | the Claude Code plugin and its marketplace manifest |

Zero runtime dependencies; `bun test` covers each module, and the five
supervision cases the SPEC's exit criterion names live together in
`supervision.test.ts`. `constraints.test.ts` asserts RF-007 mechanically over
`src/daemon/` — the CLI may fetch releases; the daemon never talks outward.

## Two things worth knowing before you edit

- **`Bun.spawn` accepts `detached` but does not `setsid`.** The child stays in
  the daemon's process group and `process.kill(-pid, …)` fails `EPERM`, so
  killing a run would leave its grandchildren alive. `proc.ts` uses
  `node:child_process` for this reason. Verified on bun 1.3.14.
- **Teardown removes the worktree but keeps the `run/<id>` branch.** The run's
  commits are the deliverable; the v0 exit criterion requires each run's branch
  to stay checkable from its ledger entry alone. Only `bun run prune` — run by
  a human, after it asks — removes anything else, and it never deletes a branch.
