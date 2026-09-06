# Kairoku CLI Phase 7 — environments per run (`kairoku.json`, the env store, ports, compose, secrets client side)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, with
> superpowers:test-driven-development (bun test, red first) and
> superpowers:verification-before-completion before the PR.

**Goal:** a run stops inheriting the machine's environment and gets its **own**. The daemon reads
the repo's `kairoku.json` from the committed base branch, merges four layers of values low → high,
resolves the app's secrets on this machine, allocates free ports per run, brings up a per-run
Docker Compose project, runs the profile's `init`, hands the merged environment to every role and
to the QA step, and tears the compose project down on every exit path.

**Spec:** `planned/kairoku-cli-phase7-environments.md` in the private planning workspace
(READ-ONLY), ruling `DECISIONS.md` §20.11; wire spec `planned/orchestration-v1.md`. The app half is
live at `bikerwhocodes/kairoku` `8142b4d3` — `src/lib/comms/protocol/index.ts` is the contract the
claim's `env: { profile, secrets }` shape is vendored from, and the root `kairoku.json` +
`compose.test.yml` there (O-2a) are the manifest this lane is built against.

**Stack:** unchanged. Bun + TypeScript, **one runtime dependency** (`@anthropic-ai/claude-agent-sdk`,
confined to `providers/claude.ts`). `constraints.test.ts` pins the dependency list to exactly that
one entry and refuses any non-relative import, so **the manifest validator is hand-written rather
than Zod** — the brief names Zod for the property that matters (an invalid manifest fails the run
with the *path* of the error), and that property is what is built and tested.

## Global constraints

- Repo `owds-inc/kairoku`, base `main` at `3f56408b`, one PR, **never merged by the builder**.
- `src/daemon/app.ts` stays the only module that may call `fetch`, over the same three routes.
- **No app change** (the secrets UI is O-5 and already shipped). No service engine besides compose.
- **Never print a token or a secret value** — not in a log line, a curated event, a run record, a
  failure message, or `kairoku env list`. A reference that cannot be resolved is reported by the
  **name of the key** and nothing else: a `op://…` pointer is a locator, and locators leak too.
- Everything binds `127.0.0.1`.

## Task 1 — the manifest

**Files:** `src/daemon/manifest.ts` (+ test)

`kairoku.json` at the repo root, read with `git show origin/<defaultBranch>:kairoku.json` against
the configured checkout — **never the worktree**, because the worktree is where the implementer is
editing and a manifest an agent just rewrote is not the repo's contract.

`parseManifest(text)` returns `{ok, manifest}` or `{ok:false, error}` where the error carries the
JSON path (`kairoku.json: env.test.ports[1] must be a string`). It is **non-strict**: unknown keys
are ignored, so the root `"$comment"` O-2a added parses. Shape: `setup[]`,
`env.<profile>.{files[], compose, ports[], inject{}, init[]}`, `check[]`, `test`,
`concurrency.test`. No manifest → `undefined` → today's behaviour.

## Task 2 — the values, merged low → high

**Files:** `src/daemon/env.ts` (+ test)

1. the checkout's `.env*` — the profile's `files[]`, read from the worktree where `copyEnvFiles`
   already put them;
2. `~/.kairoku/env/<owner>/<repo>/<profile>.env`, mode 0600 — the daemon's own store;
3. `env.secrets` from the claim: a value, or a `{ref}` resolved **here** (`op read` for `op://`,
   `aws secretsmanager get-secret-value` for an ARN). A missing resolver, or a scheme nobody here
   knows, **fails the run** naming the key;
4. per-run: `KAIROKU_PAT`, `KAIROKU_RUN_ID`, `KAIROKU_DISPATCH_ID`, the allocated ports, and the
   profile's `inject{}` with `${PORT}` substituted.

Every value from (3) and the run token join the run's masking set, which `EventBuffer` already
applies to both logs.

## Task 3 — ports and compose

**Files:** `src/daemon/compose.ts` (+ test)

`ports: "20000-29999"` in `config.json`. Allocation is a bind probe from a random offset, with a
process-wide reservation set so two members of one daemon cannot pick the same number, released at
teardown. `docker compose -p kairoku-<runId> -f <compose> up --wait` with the ports exported, and
`down -v` on the way out.

## Task 4 — one run's environment, prepared and torn down

**Files:** `src/daemon/environment.ts`, `src/daemon/runs.ts`, `src/daemon/dispatch.ts` (+ tests)

`prepareEnvironment()` does 1–4 and the compose up and the `init[]`, and hands back the merged
values plus a `teardown()`. `ExecContext` gains `onTeardown(fn)`; `RunStore.#teardown` runs it
**before** the worktree step and on **every** exit path — done, failed, cancel, timeout, daemon
shutdown — which is the existing RF-010 teardown gaining a step rather than a second mechanism.

## Task 5 — QA reads the same manifest

**Files:** `src/daemon/qa.ts`, `src/daemon/worktree.ts`

`qaPlan` takes the manifest it was given instead of reading a second copy out of the worktree, runs
`check[]` then `test` **with the merged environment**, and the `concurrency.test` semaphore is keyed
per repo rather than per limit — two different repos that both said `2` are not one queue.

## Task 6 — prune, setup, doctor, and `kairoku env`

**Files:** `src/daemon/prune.ts`, `src/cli/env.ts`, `src/cli/main.ts`, `src/cli/doctor.ts`,
`src/cli/provision.ts`, `src/cli/setup.ts`

`kairoku daemon prune` also lists orphaned `kairoku-<something>` compose projects and takes them
down with `-v`. `kairoku env set|import|list|rm` writes the 0600 store; **`list` prints names, never
values**. `setup --daemon` installs Docker where it can (apt on Linux), names the install where it
cannot (OrbStack / Docker Desktop on macOS), and asks for the port range. `doctor` checks Docker
runs, the range has free ports, the configured repo's manifest parses, and which resolvers are here.

## Done-condition

`bun test` (pass/fail/skip/errors + file count), `bunx tsc --noEmit`, the host-target release build
and `./dist/kairoku-<host> version`, `claude plugin validate plugin/`. Plus a real run against the
in-test fake app **with real Docker**: two `build-verify` members at once, each with its own compose
project and its own allocated port, both QA steps reporting counts, and no `kairoku-<runId>` project
left behind. The same shape against the real app and the real app repo is a human gate (it needs a
browser-minted daemon token) and is listed in the PR body.
