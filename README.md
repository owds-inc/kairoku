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

One daemon per machine. It **links itself to a Kairoku app** and dials out only:
it heartbeats every 30 s, polls for a dispatch every 5 s while it has a free
slot, cuts a fresh git worktree, launches exactly one agent process in it under
an injected per-run credential, supervises that process to a terminal state, and
reports the facts — the branch, a PR url if the agent opened one, the four suite
counts if the agent cited a suite. It never decides whether the work was good;
the app does, and you merge.

**`SPEC.md` is the build contract** (protocol v1; v0 is kept there as a
superseded appendix). Changes to behaviour are amendments there, never silent
divergence here.

> **Upgrading from v0.1.0 / protocol v0.** `POST /runs`, `GET /runs/{id}` and
> `POST /runs/{id}/cancel` are **gone** — runs start in the app now. The
> listener stays for `kairoku doctor`, unauthenticated, on 127.0.0.1.
> `KAIROKU_DAEMON_TOKEN` keeps its name and **changes meaning**: it is the
> credential this daemon presents to the app, printed once by Settings →
> Daemons. There is nothing to convert — an old inbound bearer is simply not a
> token the app knows. Run `kairoku setup --daemon` (or pass `--app-url` and
> `--app-token`) and `kairoku doctor` will say `PASS app link`.

`kairoku setup --daemon` provisions a machine for it — node ≥ 24 (nvm), bun,
the agent CLIs (claude, codex, paseo), the non-interactive PATH line, the app
checkout (asked once, remembered as `repoUrl` in the config), unprivileged
user namespaces for codex's sandbox (linux, sudo-gated), codex's MCP approval
mode, `~/.kairoku/config.json`, the **app link** (URL + token, written to
`token.env` mode 600 and **proved with one heartbeat before the service is
installed** — note that the token is *written* before it is proved, so a token
the app refuses stays on disk: setup exits 1 and installs no service, but a
hand-started `kairoku daemon` will still boot, take a 401, and sit with its
loop stopped until `kairoku setup --daemon` is re-run with a token that works),
then the service and a reachability check. It is idempotent
on a live machine: only what is missing gets installed, a runtime is never
upgraded under a running agent, and the service file is rewritten only when
its content changes. It ends with what only a human can do (`claude` login,
`codex login`, the codex MCP entry, any sudo step it had to skip).

```sh
kairoku setup --daemon --app-url https://kairoku.io --app-token kai_…
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
  "appUrl": "https://kairoku.io",
  "defaultBranch": "main",
  "listen": { "host": "127.0.0.1", "port": 7801 },
  "maxConcurrent": 2,
  "repoPath": "/home/neil/work/kairoku",
  "repoUrl": "https://github.com/bikerwhocodes/kairoku.git",
  "worktreesDir": "/home/neil/.kairoku/worktrees",
  "runsDir": "/home/neil/.kairoku/runs",
  "keepWorktreeOnFailure": false,
  "defaultTimeoutSec": 3600,
  "killGraceMs": 5000,
  "pluginPath": "/opt/kairoku/plugin"
}
```

`maxConcurrent` is a hard gate, not a hint: a member claimed past the limit
waits for a slot rather than being refused, and two overlapping dispatches can
never put more members on the machine than it has slots.

`pluginPath` is only needed when the Kairoku plugin is somewhere the daemon
would not look (a checkout beside the binary, or `~/.claude/plugins/…`). **A
Claude run with no plugin fails closed**, naming what is missing, and the
machine advertises no Claude models: the role agents and the `mcp__kairoku__*`
tools are the plugin, so a "run" without it would be a model with the role's
prose and none of its reach. Codex roles are unaffected — their contracts ship
inside the binary.

No credential is in that file. `KAIROKU_DAEMON_TOKEN` (the app credential) and
`KAIROKU_AGENT_TOKEN` (the interim `KAIROKU_PAT` for a run whose claim carried
no run token — it goes when the app mints one per run) live in the environment
or in `~/.kairoku/token.env` beside the config, mode 600 — which is what the
service reads, so neither the unit nor the plist carries a secret. A
`~/.hikyaku/` from before the rename is copied to `~/.kairoku/` once on first
start; `HIKYAKU_TOKEN` and `HIKYAKU_CONFIG` still work for this version, with a
deprecation line.

### What the daemon calls, and what answers it

Outbound, and this is the whole list (`Authorization: Bearer <token>`):

| Call | Carries | Answers |
|---|---|---|
| `POST <appUrl>/api/daemon/heartbeat` | `{meta: {host, version, capacity}, runs?}` | `{daemon, liveness, heartbeatIntervalMs, runs[]}` |
| `POST <appUrl>/api/daemon/claim` | — | `{dispatch}` or `{dispatch: null}` |
| `POST <appUrl>/api/daemon/update` | `{dispatchId, status, summary?, artifacts?, counts?}` | `{ok, id, status}` |

A `401` stops both timers, logs once, and leaves the listener up so `doctor` can
say `app link: token not accepted`. `5xx` and network failures back off 30 s →
5 min and reset on success; the daemon never claims while a heartbeat is
failing. A report the app could not take rides the next heartbeat in `runs[]`,
and the answer's matching `runs[i]` is read: an `{ok:false}` there is logged and
the run marked failed locally, exactly as a direct `422` is — a 200 on the beat
is not consent for what the beat carried.
`constraints.test.ts` asserts mechanically that no other module in
`src/daemon/` opens an outbound client and that no host is hardcoded.

Inbound, on 127.0.0.1, **no credential** — reachability is the boundary, which
is why the listener still refuses to bind `0.0.0.0` (RF-006):

| Route | Answer |
|---|---|
| `GET /capacity` | `{running, max}` |
| `GET /status` | `{version, capacity, link, runs}` — what `kairoku doctor` reads |

```sh
curl -s http://127.0.0.1:7801/status
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
| `src/daemon/app.ts` | the app client — the ONLY outbound module; three routes, four result tags |
| `src/daemon/link.ts` | the loop: the two timers, backoff, the 401 stop, the reports |
| `src/daemon/dispatch.ts` | a claim becomes a TEAM: one member per item, the run files, the PR url, the restart rule |
| `src/daemon/recipes.ts` | the six teams as state machines over run records — the fix loops live here |
| `src/daemon/qa.ts` | the deterministic QA step: the repo's own commands — its own package scripts, through the package manager its lockfile names — and one summary parser per runner |
| `src/daemon/policy.ts` | the per-role tool policy as data, and the one function both providers apply |
| `src/daemon/models.ts` | what this machine advertises: repos, providers → models, recipes |
| `src/daemon/providers/` | `claude.ts` (the ONLY module importing the Agent SDK), `codex.ts`, and `index.ts`'s `productionProviders()` — the one constructor every production call site builds through |
| `src/daemon/roles/` | the four role contracts as markdown, embedded in the binary; `withRoleContract()` prepends one to every prompt on BOTH providers |
| `src/daemon/server.ts` | the loopback listener, the bind, SIGTERM wiring |
| `src/daemon/runs.ts` | the live-run registry: capacity (the one gate), worktrees, teardown, cancel |
| `src/daemon/proc.ts` | process-group spawn, timeout, group kill, escalation, line streaming |
| `src/daemon/worktree.ts` | `git worktree` create/teardown, `.env*` seeding, enumeration |
| `src/daemon/events.ts` | the full per-run JSONL, and the bounded curated buffer the beat drains |
| `src/daemon/config.ts` | config file, env token, bind validation |
| `src/daemon/prune.ts` | the human-run cleanup CLI |
| `plugin/`, `.claude-plugin/` | the Claude Code plugin and its marketplace manifest |

**One runtime dependency**, `@anthropic-ai/claude-agent-sdk`, pinned and
imported by `src/daemon/providers/claude.ts` alone (DECISIONS §20.2 amends the
zero-dependency rule to name exactly that one). `bun test` covers each module,
and the supervision cases the SPEC's exit criterion names live together in
`supervision.test.ts`. The loop and the client are tested against a fake app
(`fakeApp()` in `src/daemon/testkit.ts`, a `Bun.serve` speaking the three routes
with the app's exact shapes) and the teams against a fake provider, so no test
touches the network, a real Kairoku, a real `claude` or a real `codex`.
`e2e.test.ts` runs the SPEC's whole team exit criterion against that fake app
with production code everywhere else. `constraints.test.ts` asserts RF-007,
RF-011 and the amended dependency rule mechanically over all of `src/daemon/`,
recursing into subdirectories: one outbound module, three routes, no hardcoded
host, one dependency, one file allowed to import it.

## Two things worth knowing before you edit

- **`Bun.spawn` accepts `detached` but does not `setsid`.** The child stays in
  the daemon's process group and `process.kill(-pid, …)` fails `EPERM`, so
  killing a run would leave its grandchildren alive. `proc.ts` uses
  `node:child_process` for this reason. Verified on bun 1.3.14.
- **Teardown removes the worktree but keeps the `run/<id>` branch.** The run's
  commits are the deliverable; each run's branch has to stay checkable from its
  entry in the app alone. Only `kairoku daemon prune` — run by a human, after it
  asks — removes anything else, and it never deletes a branch.
- **A run left non-terminal by a daemon that died is reported failed, never
  replayed** (SPEC RF-013). Re-running a prompt whose first attempt may have
  committed, pushed or opened a PR is worse than any stuck row.
- **A reviewer's verdict is structured output, never prose, and a missing one
  fails the run closed** (SPEC RF-015). The same goes for a planner's or
  researcher's report. "It looked fine to the reviewer" read out of free text is
  exactly the claim invariant 7 exists to refuse, so the daemon would rather
  stop than record a review that did not happen.
- **QA has no model in it** (SPEC RF-016, grill Q2). The counts on a run come
  from the repo's own runner, parsed by the daemon, or the run fails — including
  when the runner prints a summary no parser here can read, and when `errors` is
  non-zero beside zero `fail`.
- **The tool gate is a `PreToolUse` hook, not `allowedTools` alone** (SPEC
  RF-017). `canUseTool` is last in the permission chain and is shadowed by a
  bypass or allow rule; a hook deny wins even under `bypassPermissions`. The
  option list is belt beside braces.
- **One checkout per daemon, and the daemon works out which one at boot**
  (SPEC §20.9) — `git remote get-url origin` on `repoPath`, parsed to
  `owner/name`, compared case-insensitively against the claim's `repo.fullName`.
  A claim for any other repo is reported `failed` with `no checkout for <name>`
  and nothing is cut. It fails **closed**: an unreadable origin is warned about
  once at boot and then refuses every claim that names a repo, because a guard
  that passes when it cannot tell would run someone else's dispatch against
  this checkout's code.
