# Kairoku CLI

`kairoku` is one binary that sets up everything a developer laptop or an
agent VM needs to work with [Kairoku](https://kairoku.io): the Claude Code
plugin, and the orchestration daemon that runs agents in fresh git worktrees.

## Install

From the first tagged release (`v0.1.0`):

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
kairoku daemon prune                    # remove stale run worktrees and orphaned compose projects — asks first, never deletes a branch
kairoku env set|import|list|rm          # the values this machine holds for a repo's runs
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
  "repoUrl": "https://gitlab.com/owds-inc/kairoku/kairoku.git",
  "worktreesDir": "/home/neil/.kairoku/worktrees",
  "runsDir": "/home/neil/.kairoku/runs",
  "envDir": "/home/neil/.kairoku/env",
  "ports": "20000-29999",
  "keepWorktreeOnFailure": false,
  "defaultTimeoutSec": 3600,
  "killGraceMs": 5000,
  "pluginPath": "/opt/kairoku/plugin"
}
```

`maxConcurrent` is a hard gate, not a hint: a member claimed past the limit
waits for a slot rather than being refused, and two overlapping dispatches can
never put more members on the machine than it has slots.

`ports` is the range per-run service ports are allocated from. A value that does
not parse falls back to `20000-29999` with one warning rather than refusing to
start: it matters only to repos that declare a compose profile.

## A run's environment

A repo describes what its runs need in a **`kairoku.json`** at its root, and the
daemon reads it from the **committed base branch** — `git show
origin/<defaultBranch>:kairoku.json` — never from the worktree the implementer
is editing in. No `kairoku.json` means the previous behaviour, unchanged.

```json
{
  "setup": ["bun install"],
  "env": {
    "test": {
      "files": [".env.local"],
      "compose": "compose.test.yml",
      "ports": ["PG_PORT", "PROXY_PORT"],
      "inject": {
        "DATABASE_URL": "postgres://postgres:postgres@127.0.0.1:${PG_PORT}/main"
      },
      "init": ["bun run db:migrate"]
    }
  },
  "check": ["bunx tsc --noEmit", "bun run lint"],
  "test": "bun test",
  "intelligence": ["codegraph"],
  "concurrency": { "test": 2 }
}
```

`intelligence` opts a repo into CodeGraph, on probation (§21 Q2/Q4/Q15/Q19): the daemon indexes
each run's own worktree before the first role turn and hands both hosts a read-only MCP server
pointed at it, degrading silently — no `codegraph` on the machine or a failed index just runs the
role without it — rather than failing the run.

Unknown keys are ignored, so a `"$comment"` costs nothing. Anything the daemon
does read is type-checked, and an error names the path: `kairoku.json:
env.test.ports[1] must be a string`. An invalid manifest fails the run before a
worktree is cut.

Values merge **low to high**:

| | Layer | Where it comes from |
|---|---|---|
| 1 | the checkout's dotenv | the profile's `files[]`, copied into the worktree with the rest of `.env*` |
| 2 | this machine's store | `~/.kairoku/env/<owner>/<repo>/<profile>.env`, mode 0600 — `kairoku env` |
| 3 | the project's secrets | delivered in the claim; a `{ ref }` is resolved **here** |
| 4 | the run's own | the allocated ports, `inject` with `${PORT}` substituted, then `KAIROKU_RUN_ID`, `KAIROKU_DISPATCH_ID` and `KAIROKU_PAT` |

Layer 3 never touches a disk: it lives in this process and in the environment of
the processes it launches. A reference is `op://…` through the 1Password CLI or
an AWS Secrets Manager ARN through the `aws` CLI. When one cannot be resolved the run fails
**naming the key** — never the value, and never the locator, because a vault
path names the vault, the item and the field, and failure text ends up in the
app's run log. Every delivered value is masked out of the events and the local
log before the first line is written.

Each run then gets its own ports (a bind probe inside `ports`, reserved so two
members cannot pick the same number), its own compose project
(`docker compose -p kairoku-<runId> -f <compose> up --wait`), its own `init[]`,
and a `down -v` on **every** exit path — done, failed, cancelled, timed out, or
the daemon shutting down. Everything binds `127.0.0.1`; the daemon passes port
numbers and the repo's compose file decides the interface.

```sh
kairoku env set STRIPE_KEY=sk_live_…        # this repo, profile `test`
kairoku env import ./prod.env --profile staging
kairoku env list                            # the NAMES held here, never the values
kairoku env rm STRIPE_KEY
```

`--repo <owner/name>` and `--profile <name>` pick another store; the default
repo is the origin of the checkout in `config.json`, and a checkout whose origin
cannot be read is refused rather than guessed at.

### The repo's own rules

A repo can also state the code shapes it refuses, in **`.kairoku/rules/*.yml`** — ast-grep's own
rule format — and the daemon reads those from the **committed base branch** for the same reason it
reads `kairoku.json` there, plus one more: a rule an agent can delete inside its own pull request is
not a rule. A rule change takes effect after the merge. No `.kairoku/rules` means nothing runs.

```yaml
id: bun-spawn-resolved-path
language: TypeScript
severity: error
message: Bun.spawn must run the path Bun.which resolved, not the bare command name.
note: >-
  PR #7 defect 5 — a PATH change between the two ran a different binary than the one checked.
rule:
  all:
    - pattern: Bun.spawn([$CMD, $$$ARGS], $$$OPTS)
    - inside: { stopBy: end, has: { stopBy: end, pattern: Bun.which($CMD) } }
```

They are checked twice. **At the write**, as a `PostToolUse` hook on `Write|Edit`: the agent is
stopped and handed the rule's message and the `note` — the defect the rule exists for — while the
fix is still one edit away. **In QA**, over the whole worktree, before the manifest's `check`
commands: any match fails the step with the rule ids and `file:line`, and the fix loop gets that
text verbatim. Nothing in `kairoku.json` asks for either; the presence of the directory is what
turns them on, so a repo cannot opt its own gate out in the same file the gate reads.

`ast-grep` is one binary. `kairoku setup --daemon` installs it and `kairoku doctor` reports it
beside the rule count for your base branch. A repo that declares rules on a machine that has no
ast-grep **fails the run closed**, naming it, before a worktree is cut — the same way a secret
reference nobody here can resolve does. Codex runs get the same layer through a
`.codex/hooks.json` the daemon writes per run and excludes from the diff.

A repo may also keep **`.kairoku/patterns.md`** — a short list of exemplar snippets with a one-line
"why" each. Every role reads it, and its own `AGENTS.md`/`CLAUDE.md`, before the first write. An
agent may change it only inside the item it was given; the reviewer treats any other change to it
as a defect, so what a repo says about itself still changes through a human merge.

`pluginPath` is written for you by `kairoku setup --daemon` and is only worth
setting by hand when the plugin lives somewhere unusual. Left out, the daemon
takes the first of these that contains `.claude-plugin/plugin.json`: the
`installPath` `claude plugin list --json` reports for `kairoku@kairoku-marketplace`;
`~/.claude/plugins/cache/<marketplace>/kairoku/<version>` (where Claude Code
unpacks a plugin), newest version first; and, only when running from a checkout
rather than a released binary, `plugin/` beside the source. A `pluginPath` that
no longer exists — a plugin update moves the version directory — is skipped
rather than trusted. `kairoku doctor` prints the one it will use:

```
PASS  kairoku plugin installed           2.4.0 enabled
PASS  kairoku plugin path                /Users/you/.claude/plugins/cache/kairoku-marketplace/kairoku/2.4.0
WARN  codegraph                          absent — a repo whose kairoku.json lists it under `intelligence` runs without the index
```

**A Claude run with no plugin fails closed**, naming what is missing, and the
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

Build artifacts do not survive the next remote build sync; released binaries come
from the tagged GitHub Actions run, never a remote build directory.
A developer who needs a Darwin binary in hand must arrange a local build or obtain
the release artifact: the remote build host is Linux, where Bun cross-compiles
Darwin targets without executing them, and `./dist/kairoku-<host> version` proves
only the host target.

| Path | Holds |
|---|---|
| `src/cli/main.ts` | the CLI entry: one command per first argument |
| `src/cli/setup.ts`, `provision.ts` | the wizard and the machine steps |
| `src/cli/daemon.ts`, `service.ts` | `kairoku daemon` and the systemd / launchd service files |
| `src/cli/env.ts` | `kairoku env` — the value store; `list` prints names, never values |
| `src/cli/doctor.ts`, `plugin.ts`, `update.ts` | the other commands; `io.ts` is the seam every command is tested through |
| `src/daemon/app.ts` | the app client — the ONLY outbound module; three routes, four result tags |
| `src/daemon/link.ts` | the loop: the two timers, backoff, the 401 stop, the reports |
| `src/daemon/dispatch.ts` | a claim becomes a TEAM: one member per item, the run files, the PR url, the restart rule |
| `src/daemon/recipes.ts` | the six teams as state machines over run records — the fix loops live here |
| `src/daemon/manifest.ts` | `kairoku.json` from the base branch: a non-strict parser whose errors carry the JSON path |
| `src/daemon/env.ts` | the four value layers, the 0600 store, and `{ ref }` resolution that fails by name |
| `src/daemon/compose.ts` | port allocation (bind probe + reservation) and the per-run compose project |
| `src/daemon/environment.ts` | one run's environment, prepared and torn down — the wiring of the three above |
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
| `src/daemon/prune.ts` | the human-run cleanup CLI: stale worktrees and orphaned `kairoku-…` compose projects |
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
