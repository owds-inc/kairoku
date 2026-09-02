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

`kairoku plugin install|update|status` are the same steps as commands; from a
checkout, `claude plugin marketplace add /path/to/kairoku` then the same
install line. Plugin releases are tagged `kairoku--v<version>`.

## The daemon

One daemon per VM: it accepts a run request, cuts a fresh git worktree,
launches exactly one agent process in it under an injected per-slot
credential, supervises that process to a terminal state, and answers capacity
questions. It holds no state whose loss matters — the ledger in the Kairoku
app owns recovery — and it reports nothing itself. Every claim about work
comes from the agents it launches, under their own credentials.

**`SPEC.md` is the build contract.** Changes to behaviour are amendments
there, never silent divergence here.

`kairoku setup --daemon` provisions a machine for it — node ≥ 24 (nvm), bun,
the agent CLIs (claude, codex, paseo), the non-interactive PATH line, the app
checkout (asked once, remembered as `repoUrl` in the config), unprivileged
user namespaces for codex's sandbox (linux, sudo-gated), codex's MCP approval
mode, `~/.kairoku/config.json` + a `token.env` bearer (mode 600, never
printed), the service, and the doctor's 401/200 round trip. It is idempotent
on a live machine: only what is missing gets installed, a runtime is never
upgraded under a running agent, and the service file is rewritten only when
its content changes. It ends with what only a human can do (`claude` login,
`codex login`, the codex MCP entry, any sudo step it had to skip).

```sh
kairoku daemon                          # foreground, until SIGTERM
kairoku daemon install|start|stop|status   # systemd unit kairoku-daemon (linux) / launchd agent io.kairoku.daemon (mac)
kairoku daemon prune                    # remove stale run worktrees — asks first, never deletes a branch
kairoku doctor                          # PASS/WARN/FAIL per check; nonzero on FAIL
```

From source: `bun run start` (= `bun run src/daemon/server.ts`).

Config — `~/.kairoku/config.json` (`KAIROKU_DAEMON_CONFIG` overrides the path).
All keys optional:

```json
{
  "listen": { "host": "192.168.23.167", "port": 7801 },
  "maxConcurrent": 2,
  "repoPath": "/home/neil/work/kairoku",
  "repoUrl": "https://github.com/bikerwhocodes/kairoku.git",
  "worktreesDir": "/home/neil/.kairoku/worktrees",
  "runsDir": "/home/neil/.kairoku/runs",
  "keepWorktreeOnFailure": false,
  "defaultTimeoutSec": 3600,
  "killGraceMs": 5000
}
```

The bearer token is **not** in that file: `KAIROKU_DAEMON_TOKEN` in the
environment, or `~/.kairoku/token.env` beside the config (what the service
uses — so neither the unit nor the plist carries a secret). The listener
refuses to bind `0.0.0.0` (RF-006). A `~/.hikyaku/` from before the rename is
copied to `~/.kairoku/` once on first start; `HIKYAKU_TOKEN` and
`HIKYAKU_CONFIG` still work for this version, with a deprecation line.

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
  -H "authorization: Bearer $KAIROKU_DAEMON_TOKEN" -H 'content-type: application/json' \
  -d '{"role":"executor","brief":"…","env":{"KAIROKU_PAT":"…"}}'
```

## Working on it

```sh
bun test                          # the suite — counts are the merge gate
bun run typecheck                 # tsc --noEmit — bun test never type-checks
bun run src/cli/main.ts version   # the CLI from source
bun run prune                     # human-run worktree cleanup; asks first
```

### Releasing

`bun run build:release` compiles `src/cli/main.ts` for darwin-arm64, darwin-x64,
linux-x64 and linux-arm64 into `dist/kairoku-<os>-<arch>`, writes
`dist/checksums.txt` (sha256) and renders `dist/kairoku.rb`, the Homebrew
formula with those checksums. Pushing a `v<version>` tag that matches
`package.json` runs `.github/workflows/release.yml`, which builds the same and
publishes a GitHub release with the six files; `install.sh`, `kairoku update`
and the formula in `owds-inc/homebrew-tap` all read from it (copy the released
`kairoku.rb` into the tap's `Formula/` for each version).

| Path | Holds |
|---|---|
| `src/cli/main.ts` | the CLI entry: one command per first argument |
| `src/cli/setup.ts`, `provision.ts` | the wizard and the machine steps |
| `src/cli/daemon.ts`, `service.ts` | `kairoku daemon` and the systemd / launchd service files |
| `src/cli/doctor.ts`, `plugin.ts`, `update.ts` | the other commands; `io.ts` is the seam every command is tested through |
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
  to stay checkable from its ledger entry alone. Only `kairoku daemon prune` —
  run by a human, after it asks — removes anything else, and it never deletes a branch.
