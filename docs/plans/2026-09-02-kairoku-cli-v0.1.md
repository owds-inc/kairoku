# Kairoku CLI v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, with superpowers:test-driven-development (bun test, red first) and superpowers:verification-before-completion before each PR. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One installable `kairoku` binary (brew / install script) that sets up the Claude Code plugin and/or the orchestration daemon through a wizard, with the daemon and the plugin living in this repo.

**Architecture:** The existing daemon (`src/*.ts`, zero runtime deps, Bun.serve) moves under `src/daemon/` unchanged in protocol. A new `src/cli/` holds subcommands dispatched by `node:util` `parseArgs` and compiled with `bun build --compile` into per-platform single binaries published on GitHub releases. The plugin and marketplace manifest are copied verbatim from the app repo. Machine provisioning (today's bash `hikyaku` script) is ported step by step into `setup`/`doctor` in Phase 3, then the script is deleted.

**Tech Stack:** Bun 1.3 + TypeScript, `bun test`, `tsc --noEmit`, `node:util` parseArgs, `node:readline/promises`, GitHub Actions, Homebrew tap formula, launchd (mac) / systemd (linux).

**Spec:** `/Users/nihal/Work/OWDS/planning/kairoku/planned/kairoku-cli-v1.md` (READ-ONLY) — ruling in that repo's `DECISIONS.md` §19. Daemon protocol: `SPEC.md` in this repo.

**Phasing of this document:** Phase 1 is fully expanded (every step, every code block). Phases 2–4 carry the decided files, interfaces, tests and done-conditions; their code blocks are expanded at the start of each phase, after the context7 lookups the spec mandates (bun `--compile` targets, Homebrew formula DSL, launchd plist keys, `claude plugin` CLI). Each phase's PR amends this file with that expansion. Writing library-facing code four phases ahead of the lookup is the failure the spec warns about.

## Global Constraints

- Repo `owds-inc/kairoku` (renamed from `owds-inc/hikyaku`), base branch `main`, one PR per phase, **never merged by the builder**.
- Product names: **Kairoku CLI**, **Kairoku daemon**. `hikyaku` survives only in git history and the one-version shims (`HIKYAKU_TOKEN`, `HIKYAKU_CONFIG`, `~/.hikyaku/` migration).
- Package `name: "kairoku"`, `version: "0.1.0"`, `bin: { kairoku: "./src/cli/main.ts" }`, license MIT.
- Zero runtime dependencies; devDependencies exactly `@types/bun` + `typescript` (asserted by `constraints.test.ts`).
- RF-007: nothing under `src/daemon/` talks to a forge, Jira or Kairoku, and opens no outbound HTTP client (asserted mechanically). The CLI (`src/cli/`) may — `update` downloads releases.
- No CLI framework: `node:util` `parseArgs`; prompts via `node:readline/promises`.
- Never write to the app repo (`/Users/nihal/Work/OWDS/kairoku`), the planning repo, or shadcn-lib; the docs repo only in Phase 4. Read the app's plugin only via `git archive origin/main`.
- PR bodies: each numbered spec item → files; every instrument with counts (`bun test` pass/fail/skip/errors + files, `tsc --noEmit`, release build); anything only Neil can do.
- Human gates (Neil): repo public, first `v0.1.0` tag, the `kairoku--v2.2.0` plugin tag, docs going live.

---

## Phase 1 — the repo becomes the CLI repo (PR 1)

Baseline before Phase 1: `bun test` 91 pass / 0 fail across 11 files; `tsc --noEmit` clean.

### Task 1: Remote, branch, ignore tool droppings

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Point the remote at the renamed repo and cut the branch**

```bash
git remote set-url origin https://github.com/owds-inc/kairoku.git
git fetch origin
git checkout -b phase-1/cli-repo origin/main
```

- [ ] **Step 2: Ignore the two untracked tool droppings already in the tree**

Append to `.gitignore`:

```
.serena/
.DS_Store
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore .serena/ and .DS_Store"
```

### Task 2: Move the daemon under `src/daemon/`

**Files:**
- Move: every `src/*.ts` (13 modules + tests + `testkit.ts`) → `src/daemon/`
- Modify: `src/daemon/daemon.test.ts` (spawn path), `src/daemon/constraints.test.ts` (repo root)

**Interfaces:**
- Produces: `src/daemon/server.ts` exports `createDaemon`, `tokenMatches` (unchanged); `src/daemon/config.ts` exports `loadConfig`, `assertBindable` (unchanged). Phase 3's `kairoku daemon` imports from here.

All intra-daemon imports are relative (`./x`), so the move itself breaks nothing. Two tests know where the repo root is:

- [ ] **Step 1: Move**

```bash
mkdir -p src/daemon && git mv src/*.ts src/daemon/
```

- [ ] **Step 2: Run the suite — expect exactly the two path-sensitive files to fail**

Run: `bun test`
Expected: `daemon.test.ts` fails (spawns `src/server.ts` from `src/`), `constraints.test.ts` fails (`package.json` read from `src/`).

- [ ] **Step 3: Fix `daemon.test.ts` — spawn the sibling `server.ts` by absolute path**

Replace both `Bun.spawn(["bun", "run", "src/server.ts"], { cwd: import.meta.dir + "/..", …` with

```ts
Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
```

(drop the `cwd` line; `join` is already imported). Rename the tmp prefix `"hikyaku-daemon-"` → `"kairoku-daemon-"`.

- [ ] **Step 4: Fix `constraints.test.ts` — the repo root is two levels up**

```ts
const repoDir = join(srcDir, "..", "..");
```

`srcDir` stays `import.meta.dir` = `src/daemon/`: RF-007 governs the daemon, and Phase 2's `update` command in `src/cli/` legitimately fetches releases.

- [ ] **Step 5: Run the suite and the type-check — green at the new paths**

Run: `bun test && bunx tsc --noEmit`
Expected: 91 pass / 0 fail, 11 files; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "refactor: move the daemon under src/daemon/"
```

### Task 3: `package.json` becomes kairoku; `src/cli/main.ts` answers `version`

**Files:**
- Modify: `package.json`, `tsconfig.json`
- Create: `src/cli/main.ts`
- Test: `src/cli/main.test.ts`

**Interfaces:**
- Produces: `src/cli/main.ts` is the dev entry and the compile entry. Phase 2 replaces its `switch` with `parseArgs` dispatch; the `version` output `kairoku 0.1.0` is what the Homebrew `test do` block greps.

- [ ] **Step 1: Write the failing test**

`src/cli/main.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const main = join(import.meta.dir, "main.ts");

async function cli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", main, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("kairoku cli", () => {
  test("version prints the package version", async () => {
    const { code, stdout } = await cli("version");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("kairoku 0.1.0");
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const { code, stderr } = await cli("frobnicate");
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("kairoku version");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/main.test.ts`
Expected: FAIL — `main.ts` does not exist (bun reports the module not found; exit code ≠ 0).

- [ ] **Step 3: Rewrite `package.json`**

```json
{
  "name": "kairoku",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "bin": { "kairoku": "./src/cli/main.ts" },
  "scripts": {
    "start": "bun run src/daemon/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "prune": "bun run src/daemon/prune.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

`private: true` stays: this is distributed by brew and releases, never `npm publish`.

- [ ] **Step 4: Write the minimal `src/cli/main.ts`**

```ts
#!/usr/bin/env bun
/**
 * kairoku — the Kairoku CLI. Dev entry (`bun run src/cli/main.ts`) and the
 * `bun build --compile` entry. Subcommands arrive in Phase 2; this is the
 * dispatch skeleton with `version` so the binary and the formula have
 * something to assert.
 */

import { version } from "../../package.json";

const usage = `kairoku ${version}

  kairoku version   print the version
  kairoku help      this
`;

const [command = "help"] = process.argv.slice(2);

switch (command) {
  case "version":
    console.log(`kairoku ${version}`);
    break;
  case "help":
  case "-h":
  case "--help":
    process.stdout.write(usage);
    break;
  default:
    process.stderr.write(`kairoku: unknown command ${JSON.stringify(command)}\n\n${usage}`);
    process.exit(2);
}
```

- [ ] **Step 5: Let tsc resolve the JSON import**

Add `"resolveJsonModule": true` to `compilerOptions` in `tsconfig.json`.

- [ ] **Step 6: Run the test and the type-check**

Run: `bun test src/cli/main.test.ts && bunx tsc --noEmit`
Expected: 2 pass; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json src/cli
git commit -m "feat(cli): package is kairoku 0.1.0; main.ts answers version"
```

### Task 4: The plugin and its marketplace, verbatim from the app's `origin/main`

**Files:**
- Create (by archive): `plugin/**` (17 files), `.claude-plugin/marketplace.json`
- Modify: `plugin/.claude-plugin/plugin.json` (`homepage`, `repository` only)
- Test: `src/cli/plugin.test.ts`

**Interfaces:**
- Produces: `.claude-plugin/marketplace.json` named `kairoku-marketplace` with `plugins[0].source === "./plugin/"`; Phase 2's `plugin install` runs `claude plugin install kairoku@kairoku-marketplace` against exactly these names.

- [ ] **Step 1: Write the failing test**

`src/cli/plugin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (rel: string) =>
  JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, any>;

describe("plugin manifests", () => {
  test("marketplace.json points at plugin/ and the names agree", () => {
    const market = read(".claude-plugin/marketplace.json");
    const plugin = read("plugin/.claude-plugin/plugin.json");
    expect(market.name).toBe("kairoku-marketplace");
    expect(market.plugins).toHaveLength(1);
    expect(market.plugins[0].source).toBe("./plugin/");
    expect(market.plugins[0].name).toBe(plugin.name);
    expect(plugin.name).toBe("kairoku");
  });

  test("plugin.json points at this repo", () => {
    const plugin = read("plugin/.claude-plugin/plugin.json");
    expect(plugin.homepage).toBe("https://github.com/owds-inc/kairoku");
    expect(plugin.repository).toBe("https://github.com/owds-inc/kairoku");
    expect(plugin.license).toBe("MIT");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/plugin.test.ts`
Expected: FAIL — ENOENT on `.claude-plugin/marketplace.json`.

- [ ] **Step 3: Copy the plugin from the app's `origin/main` (never its working tree)**

```bash
git -C /Users/nihal/Work/OWDS/kairoku fetch -q origin main
git -C /Users/nihal/Work/OWDS/kairoku archive origin/main plugin .claude-plugin | tar -x -C /Users/nihal/Work/OWDS/hikyaku
git -C /Users/nihal/Work/OWDS/kairoku rev-parse origin/main   # cite this SHA in the PR body
```

`tar` keeps the `100755` mode on `plugin/bin/kairoku-context` and `plugin/bin/kairoku-jira`; confirm with `ls -l plugin/bin`.

- [ ] **Step 4: Repoint the two URLs**

In `plugin/.claude-plugin/plugin.json`, both `"homepage"` and `"repository"` become `"https://github.com/owds-inc/kairoku"`. Nothing else in `plugin/` changes (its README's install line is already a placeholder, `<path-or-url-of-this-repo>`).

- [ ] **Step 5: Run the test**

Run: `bun test src/cli/plugin.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Validate with the plugin CLI**

Run: `claude plugin validate .` and `claude plugin validate plugin`
Expected: both report valid.

- [ ] **Step 7: Commit**

```bash
git add plugin .claude-plugin src/cli/plugin.test.ts
git commit -m "feat(plugin): move the Claude Code plugin and marketplace from the app repo"
```

### Task 5: README for the product; SPEC retitled

**Files:**
- Rewrite: `README.md`
- Modify: `SPEC.md` (title, product name in prose, an amendment line)

- [ ] **Step 1: Rewrite `README.md`** — short: what Kairoku CLI is; install (brew, script — marked as arriving with the first release); `kairoku setup` / `doctor`; the daemon (what it is, `SPEC.md` is the contract, how to run it from source today, config keys and the API table kept); the plugin (`kairoku setup --plugin`, and the manual `/plugin marketplace add owds-inc/kairoku` path); the module table at `src/daemon/`; the two "worth knowing" notes kept verbatim. State plainly that until Phase 3 lands, the daemon still reads `~/.hikyaku/` and `HIKYAKU_TOKEN` and provisioning is the bash `./hikyaku` script.

- [ ] **Step 2: Retitle `SPEC.md`**

Title → `# Kairoku daemon — protocol v0`. Under the frozen-from paragraph add one amendment line: `Amended 2026-09-02: retitled for the Kairoku CLI repo (DECISIONS.md §19); the config dir, token env and service names are amended in Phase 3 of docs/plans/2026-09-02-kairoku-cli-v0.1.md.` Prose mentions of the product ("keeps hikyaku MIT…") → "the Kairoku daemon". RF-001…RF-010 untouched.

- [ ] **Step 3: Commit**

```bash
git add README.md SPEC.md docs/plans
git commit -m "docs: README for the Kairoku CLI; SPEC retitled; the v0.1 plan"
```

### Task 6: Done-condition, push, PR

- [ ] **Step 1: Install the plugin from this checkout**

This machine already has `kairoku-marketplace` registered from the app's working tree, so it is replaced:

```bash
claude plugin marketplace remove kairoku-marketplace
claude plugin marketplace add /Users/nihal/Work/OWDS/hikyaku
claude plugin install kairoku@kairoku-marketplace
claude plugin list | grep -A3 'kairoku@'
```

Expected: `kairoku@kairoku-marketplace` Version 2.2.0, enabled.

- [ ] **Step 2: Full instruments**

Run: `bun test 2>&1 | tail -5 && bunx tsc --noEmit && echo tsc-clean`
Expected: 95 pass / 0 fail across 13 files; tsc clean.

- [ ] **Step 3: Push and open the PR (do not merge)**

```bash
git push -u origin phase-1/cli-repo
gh pr create --base main --title "Phase 1: the repo becomes the Kairoku CLI repo" --body-file /tmp/pr1.md
```

Body: items 1–4 → files; instruments with counts; the app SHA the plugin was archived from; "the lead tags `kairoku--v2.2.0` on the merge commit"; the marketplace replacement on this machine.

- [ ] **Step 4: Report to KAI-PLAN-MAIN** — PR URL, head SHA, counts, deviations. Nothing else.

---

## Phase 2 — the binary, releases, brew, install script (PR 2)

*Decided shape; steps and code expanded at phase start after context7 (bun `build --compile` targets and flags, Homebrew formula DSL and `brew audit`, `claude plugin` non-interactive flags).*

### Task 7: `parseArgs` dispatch and a testable shell seam

**Files:** Modify `src/cli/main.ts`; create `src/cli/sh.ts`; test `src/cli/main.test.ts`.
**Interfaces (produces):**
- `sh.ts`: `type Shell = (argv: string[], opts?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>`; `export const shell: Shell` (Bun.spawn); `export function which(bin: string): string | null`. Every command takes a `Shell` parameter defaulting to `shell`, so tests inject a recording fake — the same injection pattern the daemon uses for `WorktreeOps`.
- `main.ts`: `parseArgs({ allowPositionals: true, strict: false })`, first positional selects the command; each command module exports `run(args: string[], io = { shell, stdout, stderr }): Promise<number>` and `main` exits with it. Commands: `version`, `doctor`, `setup`, `plugin`, `update` (+ `daemon` in Phase 3).
**Tests:** dispatch to each command by name; `--help` per command; exit codes.

### Task 8: `plugin install|update|status`

**Files:** create `src/cli/plugin.ts`; extend `src/cli/plugin.test.ts`.
**Behaviour:** `install` → `claude plugin marketplace add owds-inc/kairoku` then `claude plugin install kairoku@kairoku-marketplace`; `update` → `claude plugin marketplace update kairoku-marketplace` then `claude plugin update kairoku@kairoku-marketplace`; `status` → `claude plugin list` filtered to `kairoku@`. `claude` absent → print the exact install line (`npm install -g @anthropic-ai/claude-code` and the native installer URL) and return 1. Marketplace-already-present is not an error (idempotent). Exact non-interactive flags confirmed via context7/`claude plugin … --help` at phase start.
**Tests:** fake `Shell` records argv sequences; asserts the three sequences and the absent-`claude` message + exit 1.

### Task 9: `doctor`

**Files:** create `src/cli/doctor.ts`; test `src/cli/doctor.test.ts`.
**Interfaces:** `type Check = { name: string; status: "PASS" | "WARN" | "FAIL"; detail?: string }`; `export async function checks(env: DoctorEnv): Promise<Check[]>`; `run` prints one line per check and returns 1 if any FAIL. `DoctorEnv` = `{ shell, platform, home, readFile, exists, fetch }` so every check is unit-testable without the machine. Checks ported 1:1 from `cmd_doctor`: node ≥ 24, bun/claude/codex present, paseo optional (WARN), non-interactive PATH line (linux), userns sysctl (linux; WARN when the key is absent), codex `default_tools_approval_mode = "approve"`, config.json present, token.env mode 600, the service (systemd `is-active` on linux / `launchctl print` on mac — Phase 3 wires the mac half), the 401/200 round trip, paseo unit (WARN when absent), kairoku checkout present + clean (WARN when dirty). Config dir: `~/.kairoku/` with `~/.hikyaku/` fallback until Phase 3 migrates.
**Tests:** one table-driven test per check status with a fake env; the exit code rule.

### Task 10: `setup` wizard (plugin and daemon entry points)

**Files:** create `src/cli/setup.ts`; test `src/cli/setup.test.ts`.
**Interfaces:** `run(args, io)` parses `--plugin`, `--daemon`, `--all`, `--yes`; without flags asks two yes/no questions via `readline/promises` (`rl.question`, injected as `io.ask`); runs `plugin.install` and/or `daemon.setup` (Phase 3; in Phase 2 the daemon branch prints "arrives in the next release" and returns 0 — stated in the PR body).
**Tests:** flag matrix; `--yes` never calls `ask`; the prompts' answers map to the right steps (fake ask + fake shell).

### Task 11: `update` (self-update)

**Files:** create `src/cli/update.ts`; test `src/cli/update.test.ts`.
**Behaviour:** if `process.execPath` contains `/Cellar/` → print "installed via brew: run `brew upgrade kairoku`" and return 0. Else GET `https://api.github.com/repos/owds-inc/kairoku/releases/latest`, pick `kairoku-<os>-<arch>` + `checksums.txt`, download to a temp file next to the binary, verify sha256 (`node:crypto`), `chmod 755`, `rename` over `process.execPath`. `fetch` injected for tests. Same version → "already up to date".
**Tests:** brew detection; asset selection per platform; checksum mismatch aborts without touching the binary; happy path against a fake fetch and a temp "binary".

### Task 12: Release build, CI, install script, formula

**Files:** `package.json` script `build:release`; create `scripts/build-release.ts` (4× `bun build --compile --target=bun-<os>-<arch> src/cli/main.ts --outfile dist/kairoku-<os>-<arch>` + `dist/checksums.txt` via `node:crypto`); create `.github/workflows/ci.yml` (PRs: `bun install`, `bun test`, `bunx tsc --noEmit`, host-target build) and `.github/workflows/release.yml` (`v*` tag: `build:release`, `gh release create` with the five assets); create `install.sh` (POSIX sh: `uname -s/-m` → asset name; `curl -fsSL` latest release asset + `checksums.txt`; `sha256sum`/`shasum -a 256` verify; install to `/usr/local/bin` if writable else `~/.local/bin`; print `kairoku setup`; `KAIROKU_RELEASE_BASE` env override so the test can point it at a local `Bun.serve`); PR in `owds-inc/homebrew-tap` adding `Formula/kairoku.rb` (`on_macos`/`on_linux` × `on_arm`/`on_intel` `url`+`sha256`, `bin.install`, `test do` → `assert_match version.to_s, shell_output("#{bin}/kairoku version")`).
**Tests:** `src/cli/install-script.test.ts` runs `sh install.sh` against a local server serving a fake asset + checksum into a temp `PREFIX`; a tampered checksum fails. `scripts/build-release.ts` is verified by the done-condition, not a unit test.
**Done-condition:** `bun run build:release` → four binaries + checksums; `./dist/kairoku-darwin-arm64 version` prints `kairoku 0.1.0`; `./dist/kairoku-darwin-arm64 setup --plugin --yes` installs the plugin here; `doctor` exits 0 on this machine; `brew audit --strict Formula/kairoku.rb` and a local `brew install --formula ./Formula/kairoku.rb` pointed at the local `dist/` assets, since release assets stay private until Neil flips visibility (stated in both PRs).

---

## Phase 3 — the daemon inside the binary (PR 3)

*Decided shape; expanded at phase start after context7 (launchd plist keys: `Label`, `ProgramArguments`, `EnvironmentVariables`, `RunAtLoad`, `KeepAlive`, `StandardOutPath`; `launchctl bootstrap gui/$UID` vs `load`).*

### Task 13: Config moves to `~/.kairoku/`, token env renamed, shims

**Files:** modify `src/daemon/config.ts` (+ test), `src/daemon/events.ts`/`runs.ts`/`worktree.ts`/`prune.ts` defaults (`~/.kairoku/{runs,worktrees}`); sweep remaining `hikyaku` mentions in `src/daemon/` comments and test tmp prefixes.
**Interfaces:** `loadConfig()` resolution order: `KAIROKU_DAEMON_CONFIG` → `HIKYAKU_CONFIG` (deprecation line on stderr) → `~/.kairoku/config.json`. Token: `KAIROKU_DAEMON_TOKEN` → `HIKYAKU_TOKEN` (deprecation line). `export function migrateHome(): "migrated" | "already" | "none"` — copies `~/.hikyaku/` → `~/.kairoku/` once (cp -R, never move) when the former exists and the latter does not, and prints what it did; `token.env` contents rewritten `HIKYAKU_TOKEN=` → `KAIROKU_DAEMON_TOKEN=`.
**Tests:** resolution order; deprecation lines; migration happy path, no-op when both exist, no-op when neither; RF-006 unchanged.

### Task 14: `kairoku daemon` foreground + `daemon install|start|stop|status`

**Files:** create `src/cli/daemon.ts` (foreground: `migrateHome()`, then `createDaemon(loadConfig())` exactly as `server.ts`'s main; service verbs), `src/cli/service.ts` (unit/plist text generation: `systemdUnit(opts): string`, `launchdPlist(opts): string`, both pure; `install` writes only when the rendered text differs from what is on disk — the bash script's cmp rule; systemd `sudo -n` gate with the printed manual steps). Service names `kairoku-daemon` (systemd, system unit under `/etc/systemd/system/`, user unit fallback when no sudo) and `io.kairoku.daemon` (`~/Library/LaunchAgents/io.kairoku.daemon.plist`). `ExecStart`/`ProgramArguments` = the running binary (`process.execPath`) `daemon`, `EnvironmentFile`/`EnvironmentVariables` from `~/.kairoku/token.env`.
**Tests:** pure renderers snapshot-tested; "unchanged unit → no write, no restart" with a fake fs; verb → argv sequences with a fake shell.

### Task 15: `setup --daemon` and the machine steps

**Files:** extend `src/cli/setup.ts` + test. Steps ported from the bash script, each a function `(env) => Promise<StepResult>` with `StepResult = { name; outcome: "done" | "skipped" | "manual"; detail? }`: runtimes (node ≥ 24 via nvm, bun, `npm i -g` only the missing agent CLIs), non-interactive PATH line (linux only, `~/.bashrc` line 1), kairoku checkout (`git clone <url>` — url prompted with default `https://github.com/owds-inc/kairoku.git`… **no**: the *app* checkout is the worktree base; default `https://gitlab.com/owds-inc/kairoku.git` is a guess — the prompt's default is confirmed with the lead at phase start; plain `git`, never `gh`), userns sysctl (linux, sudo-gated), codex approval mode, config + token generation (`crypto.randomBytes(32).toString("hex")`, `token.env` mode 600), service install + start, the doctor round-trip (401 without token, 200 with). Idempotency rules copied from the script: install only what is missing, never upgrade a runtime, rewrite a unit only on content change. Ends with the "what is left is human-only" list.
**Tests:** each step's skip/done/manual branches with a fake env; the summary lists only outstanding items.

### Task 16: Delete the bash script; amend SPEC and README

**Files:** delete `hikyaku`; `SPEC.md` amendment (RF-003 path `~/.kairoku/runs/…`, RF-006 env `KAIROKU_DAEMON_TOKEN`, Config section, `kairoku prune`); README daemon/config sections.
**Done-condition:** `kairoku daemon` started from `~/.kairoku/config.json`; two runs dispatched concurrently with curl complete (SPEC exit criterion); `kairoku doctor` PASS here; suite + tsc green with counts.

---

## Phase 4 — docs (PR in `owds-inc/kairoku-docs`)

### Task 17: Plugin page install section
`content/docs/plugin/index.mdx`: brew / install script + `kairoku setup --plugin`; the two slash commands (`/plugin marketplace add owds-inc/kairoku`, `/plugin install kairoku@kairoku-marketplace`) kept as the manual path.

### Task 18: Runner setup page
`content/docs/orchestration/runner-setup.mdx` rewritten around `kairoku setup --daemon` and `kairoku doctor`; the human-only steps stay manual with their reasons; one line saying the daemon used to be called hikyaku.

### Task 19: CLI page
New `content/docs/cli/index.mdx`: install (brew, script), every command in one table, config paths (`~/.kairoku/config.json`, `token.env`, `KAIROKU_DAEMON_TOKEN`, `KAIROKU_DAEMON_CONFIG`), the daemon service on each OS, updating (`kairoku update` / `brew upgrade`).
**Done-condition:** `bun run build` in the docs repo green, cited; `grep -ri hikyaku content/` returns only the one runner-page line.
