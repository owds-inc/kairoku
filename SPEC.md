# Kairoku daemon — protocol v1

*Ratified 2026-09-02 from planning `DECISIONS.md` §20 (rulings 1–3, 9) and `planned/orchestration-v1.md`.
Build lanes: `planned/kairoku-cli-phase5-daemon-client.md` (the link) and
`planned/kairoku-cli-phase6-teams.md` (the team); plans of record
`docs/plans/2026-09-02-kairoku-cli-phase5-daemon-client.md` and
`docs/plans/2026-09-02-kairoku-cli-phase6-teams.md`. This file is the build contract; changes
to it are explicit amendments, never silent divergence. No dates, no estimates.*

**Amended again for `StructuredOutput` (§20.4, §20.8), same v1.** The wire did not change. What
changed is RF-017: every role's tool list now names the Agent SDK's own `StructuredOutput` tool
(`daemon/structured-output`) — production found every schema-bearing reviewer, planner and
researcher turn denied that tool and failing closed, because it was on no role's list.

**Amended again for the Floor's live cadence (DECISIONS.md §23.2), same v1.** The wire did not
change a fourth time — `update`'s body already accepted `events` for a progress report. What
changed is WHEN they travel: curated events now flush every 2 s while a run is active, on `update`
directly, off the 10 s/30 s heartbeat entirely. The amendment is marked inline: RF-012 points at
it, and RF-020 is new.

**Amended again for environments (§20.11, O-4), same v1.** The wire did not change a third time.
What changed is what a member is GIVEN: its own `kairoku.json` profile, its own merged environment,
its own ports and its own compose project, torn down on every exit path. The amendments are marked
inline: RF-010 and RF-016, plus RF-019 which is new. Nothing was added to the daemon's dependency
list — the manifest validator is hand-written, because §20.2 names exactly one runtime dependency
and `constraints.test.ts` enforces the count.

**Amended for teams (§20.2, §20.4–8 and the grill), same v1.** The wire did not change; what runs
behind it did. A dispatch is a TEAM now — one member per item, each in its own worktree, driven by
a recipe through one of two providers, gated by a reviewer's structured verdict and a deterministic
QA step, streaming curated events up the beat and obeying the beat's cancel list. The amendments
are marked inline: the stack's dependency rule (one, named), RF-003, RF-004, RF-008, RF-009, RF-012
and RF-013, plus RF-014 to RF-018 which are new.

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

Bun + TypeScript, `Bun.serve`, **exactly one runtime dependency: `@anthropic-ai/claude-agent-sdk`,
pinned, imported by `src/daemon/providers/claude.ts` and nowhere else** (§20.2 amends v1's
zero-dependency rule to name that one; `constraints.test.ts` enforces the amendment, and its scan
recurses so a subdirectory is not a place the rules stop applying). In-memory run state (a `Map`)
plus one `<runId>.json` per run on disk. Per-run JSONL event log + captured stream (a log, not
state). `tsc --noEmit` clean and `bun test` green (with counts) are the merge gates.

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
  **AMENDED — the cadence is adaptive (grill Q6):** every 10 s while any run is active, and at the
  app's own `heartbeatIntervalMs` (30 s) when nothing is. An app asking for something faster than
  10 s is obeyed rather than overridden.

  **AMENDED — `meta` says what this machine can do:** `{ protocol, host, version, capacity, repos,
  providers, recipes }`. `repos` is `owner/repo` per checkout (the claim query filters on it, grill
  Q21); `providers` is provider → the models that tool itself reported (`supportedModels()` for
  Claude, `codex debug models` projected to slugs for Codex), asked ONCE per daemon and cached —
  a new model is a daemon restart (§20.6). A provider that advertises nothing is left out rather
  than sent as an empty list: "no codex here" and "codex with no models" are different facts.

  **AMENDED — one report per RUN.** A beat carries one entry per live run (`{dispatchId, runId,
  role, state, events}`) plus any terminal report `update` could not deliver. **A live entry's
  `events` is no longer the only way one travels — see RF-020**: the beat may still carry whatever
  is pending at its own moment, but the fast path is the flush.

  **A 200 on the beat is not consent for what the beat carried.** Each entry of the response's
  `runs[]` is paired with the report it answers **by `runId` when the app sends one**, falling back
  to position only when it does not, and a length mismatch is logged rather than silently mapped.
  An `{ ok: false }` entry is answered exactly as a direct `update` refusal is — logged once with
  the app's reason and issues, and the run marked `failed` locally. **The refused report is never
  retried; ONE follow-up `failed` report carrying the refusal reason is sent instead**, because a
  refused terminal report otherwise leaves the app row `running` forever while the daemon has
  stopped working on it (a `failed` report needs no counts, so it cannot be refused for the reason
  the first one was). A refused follow-up is only logged. `doctor` reads the last error and it
  names the run it came from.

- **RF-020 — the active flush (§23.2, new).** A third timer, `ACTIVE_FLUSH_MS` (2 s): while any run
  is active, each one's curated events are drained (`store.drainEvents`, still bounded by
  `EVENTS_PER_REPORT_MAX`) and sent on `client.update(...)` directly — the same body shape v1
  already accepts for a progress report, `{ dispatchId, runId, status: "running", events }` — rather
  than waiting for the next heartbeat. It ticks constantly, like the claim timer, and is simply a
  no-op while nothing is running: no second start/stop lifecycle to keep in sync with the beat and
  the claim. A send that fails is never lost — the drained batch is held (daemon-local, keyed by
  run id, not written back into the event buffer) and leads the next tick's events for that run — so
  a `server`/`network` hiccup costs a delay, never a line. `unauthorized` halts this timer exactly as
  it halts the other two. `doctor`'s app-link check names the cadence.

- **RF-013 — the restart rule. AMENDED (§20 item 9).** Each run keeps
  `~/.kairoku/runs/<dispatchId>/<runId>.json`
  `{ dispatchId, runId, state: starting|running|done|failed, pid?, startedAt, branch, worktree?,
  sessionId?, report? }` — one file per member, all of a dispatch's members in one directory.
  On boot a run left non-terminal is reaped and reported `failed` / "daemon restarted" **unless a
  live process with that pid was started at the recorded time**: pid alone is not enough, because
  a recycled number would make the daemon decline to reap a genuinely stranded run forever, and
  the daemon's own pid on a run it did not start means exactly that recycling happened.
  Unreadable — no `ps`, no permission — reaps, because a stranded run reported failed is
  recoverable and a run left `running` in the app is not. **It is never relaunched.**
  `report?` is a terminal report the app has not accepted; it is retried on every beat until a 2xx
  and cleared then, so a daemon killed between finishing a run and reporting it still settles the
  row on its next boot.

### Running the work

- **RF-001 — `POST /runs`. RETIRED (§20.3).** Runs start in the app. The route, its refusal
  vocabulary (`capacity_full` · `unknown_role` · `missing_credential` · `duplicate_credential` ·
  `empty_brief`) and the refusal-not-queueing rule are all deleted. Capacity is now a gate on
  *claiming*, not a refusal to a caller.
- **RF-002 — `GET /runs/{id}`. RETIRED (§20.3).** The app is the ledger; `GET /status` lists what is
  in flight for `doctor`.
- **RF-003 — events. AMENDED (§20 item 7).** Two logs, one truth. Everything a provider emits is
  appended in full to `~/.kairoku/runs/<dispatchId>/<runId>.jsonl`, alongside `<runId>.log` (the
  raw provider stream) and the structured lifecycle lines (created, started, finished, teardown,
  error). What travels to the app is a CURATION of it: `{seq, ts, kind, text}` with `kind` one of
  `text|tool|ok|deny|error`, text ≤ 2 KB, tool calls summarised to a name plus 200 characters,
  every delivered value masked, at most 50 lines a beat, oldest dropped first with one line saying
  how many. **Every delivered batch is monotonic by `seq`, the one after a drop included**: the
  overflow notice is numbered at DROP time, so it carries the seq of the first line it stands in for
  and leads the survivors. That seq was never delivered — the line it belonged to was the one
  dropped — so nothing collides. A notice numbered at drain time would sort after every line it
  precedes, and the app renders a batch by seq. `artifacts.jsonl` is GONE from the wire: §20.12 makes the app the control panel, so
  there is nothing on the machine left to point at.
- **RF-004 — `POST /runs/{id}/cancel`. RETIRED (§20.3)** as a route, and **REPLACED (grill Q5)** by
  the heartbeat response's `cancel[]`. Each entry names a dispatch or one run of it; the daemon
  interrupts what that member is currently doing (the SDK's own `interrupt`, or SIGTERM → grace →
  SIGKILL on the process group), tears the worktree down and reports `failed` / "cancelled by the
  app". Acting on the list is idempotent and a cancel for a run this daemon does not hold is
  ignored rather than answered.
- **RF-005 — `GET /capacity`** → `{ running, max }` (max from config). Unauthenticated, loopback.
  **AMENDED (teams): `maxConcurrent` is a GATE, enforced in one place — `RunStore.start()`.** A
  member past the limit WAITS for a slot rather than being refused; it was claimed, so it is owed a
  run. `running` counts members that hold a slot, never one still queued, because the beat and the
  claim loop both read that number. The fan-out bounds itself by `store.free()` at launch, never by
  `maxConcurrent`: two dispatches overlap by design (the claim loop refuses only when NOTHING is
  free), so a fan-out that bounded itself by the machine-wide max would put a whole machine's worth
  of members on top of the ones already running.
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
- **RF-009 — roles are a fixed table in the daemon. AMENDED (§20.5).** The `executor` role and its
  module are retired, as this requirement said they would be. There are now **four roles**:
  `implementer`, `reviewer`, `planner`, `researcher`. **QA is not one of them** (grill Q2) — it is
  a deterministic daemon step, RF-016. For Claude the roles are the plugin's own agents
  (`plugin/agents/*.md`, canonical in this repo since §19.4); for Codex the daemon writes the same
  four contracts as prompts (`src/daemon/roles/*.md`, embedded in the binary as text imports). The
  role contract is prepended to EVERY prompt on both providers — through ONE helper,
  `withRoleContract(role, prompt)`, which both `claude.ts` and `codex.ts` call, because a line each
  provider is trusted to remember is a line one of them forgets. What a run without the plugin
  loses is the MCP tools and the skills; the role survives. **On the Claude side that run does not
  happen at all** — see RF-014.
- **RF-010 — teardown on every exit path**: normal exit, timeout (default 3600 s, per-run override),
  cancel, and daemon shutdown (SIGTERM kills children, marks running runs, writes final events).
  Agent processes spawn in their own process group; kill is group-wide (no orphans). Worktree
  teardown runs unless the run failed and `keepWorktreeOnFailure` is set.
  **AMENDED (O-4): the RUN ENVIRONMENT comes down first, and unconditionally.** `ExecContext`
  carries an `onTeardown(fn)` the member's body registers BEFORE it knows whether its environment
  even came up, and `RunStore` runs it ahead of the worktree step on every path above — because
  `docker compose down` needs the compose file that lives in the worktree, and because a project
  that came up before the init step failed must not outlive the run. It runs even under
  `keepWorktreeOnFailure`: a kept worktree is for reading a failure, and containers left running
  are not evidence, they are a machine that slowly fills up. It cannot throw into the run's exit
  path — a teardown that throws is a run that never reports.

## The team requirements (new in the teams amendment)

- **RF-014 — providers.** One interface: `launch(run) → { events, interrupt(), exit }`, and nothing
  above it knows which tool is driving a role. `providers/claude.ts` is the ONLY module importing
  the Agent SDK: `cwd` = the worktree; `plugins: [{type:'local', path}]` (NOT `settingSources`);
  `permissionMode` and `allowedTools` per role AND an unconditional `PreToolUse` hook, because
  `canUseTool` is last in the permission chain and is shadowed by a bypass or allow rule while a
  hook deny wins even under `bypassPermissions`; `outputFormat: {type:'json_schema', schema}` read
  back from `message.structured_output`; `effort` per role; the session id recorded; streaming-input
  mode, which is what makes `supportedModels()` and `interrupt()` available at all;
  `pathToClaudeCodeExecutable` = the resolved `claude`. `providers/codex.ts` is
  `codex exec --json -s <sandbox from the policy> -c approval_policy="never" -C <worktree>
  [-m <model>] [--output-schema <file> -o <file>]`, prompt on stdin. Three upstream codex bugs are
  designed around rather than hoped about: the schema is read from the `-o` FILE, never from the
  event stream (openai/codex#19816), the file is parsed leniently because the schema is ignored
  while MCP servers are active (#15451), and a missing report fails the run closed (#4181).

  **ONE PRODUCTION CONSTRUCTOR, `productionProviders(config)`.** The plugin path
  (`resolvePluginPath({configured: config.pluginPath})`) and the resolved `claude` are resolved
  once, there, and handed into `claudeProvider()`; `link.ts`, `dispatch.ts` and `models.ts` all build
  their providers through it and nothing in production calls `providerRegistry()` bare. This is a
  requirement rather than a detail because the wiring it does is invisible in a unit test and fatal
  without it: a `claudeProvider({})` is a perfectly working provider that happens to start every run
  with no kairoku MCP server, no protocol skills and no role agents. **A machine with no plugin
  FAILS THE RUN CLOSED** with a summary naming what is missing, and advertises no Claude models — a
  role agent is a plugin agent, so without the plugin there are no `mcp__kairoku__*` tools, which
  are the very tools RF-017 allows and the role contracts instruct the agent to call.

  **WHERE THE PLUGIN IS LOOKED FOR (amended).** `resolvePluginPath()` returns the first candidate
  that contains `.claude-plugin/plugin.json`, in this order: `config.pluginPath`; the `installPath`
  that `claude plugin list --json` reports for `kairoku@kairoku-marketplace`, read through the ONE
  parser `doctor` uses (`cli/plugin.ts`'s `pickPlugin`); `~/.claude/plugins/cache/<marketplace>/
  kairoku/<version>`, which is where Claude Code actually unpacks a plugin, highest version by
  semver; and only then a checkout beside the source. **A cache entry the comparator does not accept
  is SKIPPED, never a throw** — `Bun.semver.order` raises `Invalid SemVer` rather than ordering one,
  and a throw inside `sort` escapes the resolver into `doctor`, `setup --daemon`, link start and
  every dispatch. **The domain test IS the comparator, by construction**: an entry is a version
  candidate only when `Bun.semver.order(entry, entry)` does not throw, so the sort only ever sees
  values its comparator takes. No stand-in predicate — `Bun.semver.satisfies(v, "*")` is not that
  domain (true for `2.2.0.bak`, `1.2.3.4` and `2.2.0~`, each of which then raises from `order`;
  false for `1.0.0-beta`, which `order` accepts). The triggers are all ordinary: `mv 2.2.0 2.2.0.bak`
  before pinning a version, the `.DS_Store` Finder writes into any directory a person opens, and the
  commit hash Claude Code names the version directory with when a marketplace entry carries no
  version. A stray entry is ignored exactly like a directory with no manifest, and the whole cache
  scan is wrapped so that any throw inside it yields no candidates — `resolvePluginPath()` returns a
  validated path or `undefined`, never a throw, whatever the filesystem holds. **The candidates are evaluated LAZILY, in
  order** — each is produced only when the one before it failed to validate, so a `config.pluginPath`
  that still exists costs no `claude plugin list --json`, a synchronous ~210 ms spawn
  `productionProviders()` would otherwise pay once per dispatch. **`config.pluginPath` is a
  candidate, not an answer** — it is validated like every other one, so a path recorded before a
  plugin update does not outlive the version directory it names. **The checkout candidate is
  offered only when the process is not a compiled binary**: `bun build --compile` gives
  `import.meta.dir` the value `/$bunfs/root`, so a path derived from it can only ever resolve in
  development — offering it in a shipped binary is how "the plugin is never handed to the SDK in
  production" hid behind a passing suite. `kairoku setup --daemon` resolves the same way and
  RECORDS the result as `pluginPath`, so a released daemon starting cold on a provisioned machine
  does not have to resolve anything; `kairoku doctor` prints the directory a launched run will be
  given (`kairoku plugin path`) as a check separate from `kairoku plugin installed`, because those
  two facts came apart in exactly the way that made every Claude run on a "PASS" machine refuse.

- **RF-015 — recipes.** A team is deterministic code over run records, testable against a fake
  provider, never an agent deciding whom to spawn. `solo` (implementer → QA); `build-verify`
  (implementer → reviewer → on NOT_CLEAN re-run the implementer with the defects VERBATIM, ≤ 2 fix
  rounds per gate → QA → the same loop on a failing suite); `phase-team` (build-verify per item of
  the claim, in parallel up to `maxConcurrent`, one worktree and branch `run/<dispatchId>-<n>`
  each); `plan` (planner → reviewer); `research` (researcher → reviewer); `custom` (the escape
  hatch, which KEEPS the QA gate because the app refuses an `implement` run reporting done without
  all four counts). A reviewer's verdict is the structured report
  `{verdict: CLEAN|NOT_CLEAN, defects: [...]}`; **absence or invalidity fails the run closed**,
  because a review read out of free prose is exactly the claim invariant 7 exists to refuse. An
  unknown team name is reported failed with the name it was asked for.

- **RF-016 — the QA step is deterministic and has no model** (grill Q2). It runs the repo's
  `kairoku.json` `check[]` then `test`, or package.json's `lint`/`build`/`test` when there is no
  manifest, in the member's worktree **with the run's own merged environment (O-4)**, and parses
  the runner's own summary — one parser per known
  runner (bun, vitest, jest, `go test -v`). **The package.json fallback runs the package's OWN
  scripts, through the package manager its lockfile names** (`bun.lock`/`bun.lockb` → `bun run`,
  `pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn`, else `npm run`) — never `bun test` in place
  of a `test` script that is `vitest run`, `jest` or `go test ./...`. Substituting the runner is
  worse than not running one: against a repo bun's glob matches but cannot drive, bun prints
  `0 pass · 0 fail` and exits 0, which parses as a clean zero-count suite, so the member would
  report done citing counts no suite of that repo ever produced. It FAILS CLOSED in three places a plausible
  implementation would have passed: a runner nobody here can parse ("counts unavailable"), a repo
  with no test command at all, and a non-zero `errors` beside zero `fail`. A failure attaches the
  last 100 lines as the defect and feeds the implementer's fix loop exactly as a reviewer's defects
  do. `concurrency.test` bounds how many suites run at once, else one at a time.

  **AMENDED (O-4), two ways.** The manifest is the one read from the BASE BRANCH (RF-019), handed
  in rather than read out of the worktree a second time: the worktree is where the implementer is
  editing, and a gate whose `check` and `test` commands the agent under review can rewrite is not a
  gate. And the `concurrency.test` semaphore is keyed **per repo**, not per limit — two repos that
  both said `2` are two queues, and keying by the number made a daemon holding two checkouts
  serialise them against each other for no reason either repo could see. The suite also inherits
  the run's merged environment rather than the daemon's: a suite given the machine's own
  `DATABASE_URL` runs green against the developer's database while the run's own compose project
  sits there untouched.

- **RF-017 — the tool policy is data, and one function applies it** (§20.8). implementer:
  read/edit/write/run, and every write path must resolve INSIDE that member's worktree; reviewer:
  read + run, no write tool at all; planner and researcher: MCP + read-only, no shell. It fails
  closed at every branch — an unknown role, an unlisted tool, a write whose path cannot be read.
  Both providers read the same table, so they cannot drift into different ideas of what a reviewer
  may do. **Every denial is a `deny` event** and carries its reason to the model. Every role's list
  also carries `StructuredOutput` — the Agent SDK's own tool for delivering an `outputFormat`
  answer — because a schema-bearing turn (reviewer, planner, researcher) has no other way to
  report: denying it fails the turn closed even though the model did everything asked of it
  (production, 2026-09-03; amended by `daemon/structured-output`).

- **RF-019 — a run gets its own ENVIRONMENT (§20.11, O-4).** Four things, in this order.

  **The manifest.** `kairoku.json` at the repo root, read with
  `git show origin/<defaultBranch>:kairoku.json` against the configured checkout — **never the
  worktree**, for the RF-016 reason above, and read ONCE per dispatch so that every member of a
  team runs the same contract even if someone pushes to the base branch mid-fan-out. It is
  NON-STRICT about keys it does not know (the app repo's own manifest carries a `"$comment"`
  pointing at the ruling, and a schema that refused it would make documenting the file a build
  failure) and strict about the type of every key it reads, with the JSON **path** in the error —
  `env.test.ports[1] must be a string`, never "invalid manifest". A `compose` that is absolute or
  contains `..` is refused: it is a file this daemon runs with the run's own secrets exported into
  it. An invalid manifest fails the run before a worktree is cut. **No manifest → today's
  behaviour**, exactly.

  **The values, merged low → high.** (1) the profile's `files[]`, read from the worktree where the
  base checkout's `.env*` were already copied; (2) `~/.kairoku/env/<owner>/<repo>/<profile>.env`,
  mode 0600, written by `kairoku env set|import|list|rm` — `list` prints names and never values;
  (3) the claim's `env.secrets`, a value or a `{ref}` resolved HERE (`op read` for `op://`,
  `aws secretsmanager get-secret-value` for an ARN) and held in memory only, never written under
  `~/.kairoku` and never into the worktree; (4) per-run — the allocated ports, the profile's
  `inject{}` with `${PORT}` substituted, then `KAIROKU_RUN_ID` and `KAIROKU_DISPATCH_ID`, then
  `KAIROKU_PAT` last, so that a manifest naming `KAIROKU_PAT` in its `inject` cannot hand the agent
  a credential of the repo's choosing. **A failure names the KEY and nothing else** — not the
  value, not the `op://…` that names the vault, the item and the field, and not the resolver's
  stderr (vault CLIs routinely echo the locator they failed on). Failure text reaches the app's run
  log, which is read by everyone who can see the project. Every delivered value joins the run's
  masking set BEFORE the first event can be written.

  **Ports and services.** `ports: "20000-29999"` in config.json. Allocation is a bind probe from a
  random offset with a **process-wide reservation**, because the probe must close the socket before
  compose can open it and the next member of the same daemon would otherwise probe the same free
  number a millisecond later; the reservation is released at teardown. Then
  `docker compose -p kairoku-<runId> -f <compose> up --wait` with the ports exported, the profile's
  `init[]` in the worktree with the merged environment, and the role launch. The bind ADDRESS is
  the repo's compose file's business, never this daemon's — it passes numbers. The allocated ports
  are recorded in the run's json.

  **Teardown** is RF-010's, amended above. `kairoku daemon prune` also offers orphaned
  `kairoku-<something>` projects and takes them down with `-v`; the bare `kairoku` project is never
  offered, because that is what `docker compose up` in the app checkout creates and pruning it
  would stop the machine owner's own database.

- **RF-018 — the per-run wall clock.** `limits.runSeconds` from the claim, default 3600. A member
  that passes it is interrupted, torn down and reported `failed` / "time limit". A run that will
  not stop is a slot that never comes back, which is worse for the next dispatch than this one
  failing.

## A dispatch becomes a team

One claim → one member per item, fanned out up to the slots FREE at launch (a worker pool, so the
third of three starts the moment either of the first two finishes). The machine-wide limit itself is
enforced one layer down, in `RunStore.start()` (RF-005), which is the only thing two overlapping
dispatches both go through. Each member gets its own worktree cut
from `origin/<defaultBranch>` in the configured checkout — `run/<dispatchId>` for a single item,
`run/<dispatchId>-<n>` for a team — with `bun install` and the base checkout's `.env*` copied.
`KAIROKU_PAT` = that item's `runToken`, else `KAIROKU_AGENT_TOKEN` (RF-008). A role's prompt goes in
on **stdin** for codex and as a streaming user message for the SDK — never argv, so it stays out of
the process table and a prompt beginning with `-` is not read as a flag.

`update running` once per member at launch (§20 addendum 6: a dispatch whose progress showed only
in the beat's `runs[].state` would stay `claimed` in the app and be re-claimable after the lease);
at the end, `update done|failed` with `artifacts.branch`, `artifacts.prUrl` (`gh pr view` /
`glab mr view` on the branch, asked of the base checkout because the worktree is gone by then, and
run through the RESOLVED binary path so `which` and `spawn` cannot answer from different PATHs),
`artifacts.documentIds` when a planner or researcher filed any, and `counts` **measured by the QA
step** — never parsed out of an agent's prose.

**§20.9 — one checkout per daemon.** A claim naming a repo this daemon has no checkout of is
reported `failed` with `no checkout for <owner/name>`, immediately. Never a hang, never an attempt.
A repo map with auto-clone is the follow-up.

The left-hand side of that comparison is **derived once at boot** from
`git -C <repoPath> remote get-url origin` — `https://host/owner/name[.git]` and
`git@host:owner/name[.git]` both parse, the `.git` suffix is dropped, and a nested GitLab group
keeps its whole path because that *is* the name. There is no `config.json` field for it: a second
place to state the same fact is a second place for it to be wrong. The comparison is
case-insensitive; forges are.

It **fails closed.** If the remote cannot be read or parsed the daemon logs one warning at boot and
every claim that *names* a repo is refused with the same `no checkout for <owner/name>`; a claim
that names no repo at all still runs against the configured checkout, because that is the app
saying "wherever you are". A guard that passes when it cannot tell is not a guard — it would let a
dispatch aimed at a second repo execute against the first one's code.

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
defaultBranch, maxConcurrent, repoPath, repoUrl?, worktreesDir?, runsDir?, envDir?, ports?,
keepWorktreeOnFailure?, defaultTimeoutSec?, killGraceMs? }`. `ports` is the O-4 range (default
`"20000-29999"`); a value that does not parse falls back to the default with one warning rather
than refusing to start, because it matters only to repos with a compose profile and taking a whole
machine offline over a typo in a field most repos never use is the wrong trade. `envDir` (default
`~/.kairoku/env`) is the value store `kairoku env` writes. Credentials via `KAIROKU_DAEMON_TOKEN` /
`KAIROKU_AGENT_TOKEN` in the environment or `~/.kairoku/token.env` (mode 600), never config.json.
`~/.hikyaku/`, `HIKYAKU_TOKEN` and `HIKYAKU_CONFIG` are honoured for one version with a deprecation
line and a one-time copy of the directory.

## v1 exit criterion (the done-condition)

A daemon set up with a token minted in Settings → Daemons appears there **online within a minute**,
claims a queued `implement` dispatch composed on a plan item, runs it, and the run shows a branch and
(if the agent opened one) a PR url; killing the daemon turns it stale then offline on the app's
clock.

**With teams (amended):** a `phase-team` dispatch queued for three items on a capacity-2 machine
runs two members at once, one item goes through a reviewer fix loop and one through a QA fix loop,
all three end with PR urls and four counts in the app, the run detail shows the curated events,
cancelling one run interrupts only that member within one beat, and the beat advertises the repos,
models and recipes the composer greys its dropdowns against.

**With environments (amended, O-4):** two `build-verify` members on one machine at the same time
each get their own compose project and their own allocated port, the init step reaches a service on
the port it was told it had, both QA steps report four counts, the app's delivered secret appears in
neither log, and no `kairoku-<runId>` project is left standing. Against the app repo that is
postgres and the proxy per run; in this repo's own suite it is one redis, and the case SKIPS with a
printed reason where Docker is not usable — no test pulls an image.

Plus: the full `bun test` suite green **with counts reported**, `tsc --noEmit` clean,
`claude plugin validate plugin/` passing, and tests covering the beat cadence, the capacity gate,
the double-claim guard, the 401 stop, the backoff, the report contents, the restart rule, the
constraint pins, setup's proving heartbeat, each recipe against a fake provider, the QA parser per
runner, the policy matrix, the PreToolUse deny event, a structured report failing closed, event
truncation/masking/overflow, and cancel.

## Deliberately out of v1 (each is a named lane)

live terminal attach/steering · scheduling · providers beyond two · custom recipes and an agent-led lead role ·
per-item claims across daemons · a repo map with auto-clone · any auto-approval of agent permission
requests (no trigger — this is a gate, not a backlog item).

Delivered since v1 was ratified, and no longer out: recipes beyond `solo`, the Agent SDK provider,
the four role agents, the per-role tool policy, curated events over the beat, cancel from the app
(**O-3**) · per-run MCP tokens and the runs/events tables (**O-2**) · `kairoku.json` environments,
compose per run, per-run ports and secrets client-side (**O-4**, RF-019).

Still out, and named: a second service engine besides compose · vault resolvers beyond 1Password
and AWS Secrets Manager · end-to-end secret encryption (the app server can decrypt — recorded
honestly in §20.11) · a lock that bounds suites across two daemons sharing one machine.

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
