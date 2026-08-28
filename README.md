# hikyaku 飛脚

Owned dispatch daemon for Kairoku agent runs on the homelab VMs. One daemon per
VM: it accepts a run request, cuts a fresh git worktree, launches exactly one
agent process in it under an injected per-slot credential, supervises that
process to a terminal state, and answers capacity questions.

It holds no state whose loss matters — the ledger in the Kairoku app owns
recovery — and it reports nothing itself. Every claim about work comes from the
agents it launches, under their own credentials.

**`SPEC.md` is the build contract.** Changes to behaviour are amendments there,
never silent divergence here. Planning history lives in `kairoku-plan/orch/`.

## Run it

```sh
bun install
HIKYAKU_TOKEN=… bun run start          # or: HIKYAKU_CONFIG=/path/to/config.json
bun test                               # suite
bun run typecheck                      # tsc --noEmit — bun test never type-checks
bun run prune                          # human-run worktree cleanup; asks first
```

`~/.hikyaku/config.json` (all keys optional):

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

The bearer token is **not** in the file: `HIKYAKU_TOKEN` comes from the
environment (the systemd unit). `HIKYAKU_CONFIG` overrides the config path.
The listener refuses to bind `0.0.0.0` (RF-006).

## API

Every route requires `Authorization: Bearer $HIKYAKU_TOKEN`.

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

## Modules

| File | Holds |
|---|---|
| `server.ts` | routes, bearer auth, the bind, SIGTERM wiring |
| `runs.ts` | the run `Map`, the refusal set, lifecycle, teardown policy |
| `roles.ts` | the fixed role table — the only place a command line is built |
| `proc.ts` | process-group spawn, timeout, group kill, escalation |
| `worktree.ts` | `git worktree` create/teardown, `.env*` seeding, enumeration |
| `events.ts` | per-run JSONL + stdout capture |
| `config.ts` | config file, env token, bind validation |
| `prune.ts` | the human-run cleanup CLI |

Zero runtime dependencies; `bun test` covers each module, and the five
supervision cases the SPEC's exit criterion names live together in
`supervision.test.ts`.

## Two things worth knowing before you edit

- **`Bun.spawn` accepts `detached` but does not `setsid`.** The child stays in
  the daemon's process group and `process.kill(-pid, …)` fails `EPERM`, so
  killing a run would leave its grandchildren alive. `proc.ts` uses
  `node:child_process` for this reason. Verified on bun 1.3.14.
- **Teardown removes the worktree but keeps the `run/<id>` branch.** The run's
  commits are the deliverable; the v0 exit criterion requires each run's branch
  to stay checkable from its ledger entry alone. Only `hikyaku prune` — run by a
  human, after it asks — removes anything else, and it never deletes a branch.
