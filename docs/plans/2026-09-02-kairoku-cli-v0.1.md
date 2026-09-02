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

*Amended 2026-09-02 at phase end: the decided shape below is what was built. Lookups made first:
context7 for bun `build --compile --target=bun-<os>-<arch>` + `--outfile`, the Homebrew formula
DSL (`on_macos`/`on_linux` × `on_arm`/`on_intel`, `bin.install`, `test do`) and the plugin CLI
(`claude plugin install <p@m> --scope user`, `plugin update <p> -y`, `plugin list --json`,
`plugin marketplace list --json`, `marketplace update <name>`).*

### Task 7: `Io` seam, test fake, dispatch — DONE

**Files:** `src/cli/io.ts` (`Io`: platform/arch/home/uid/execPath/env, `out`/`err`, `ask` via
`node:readline/promises`, `which` = `Bun.which`, `shell` = `Bun.spawn` capturing or `live`,
`exists`/`readFile`/`mode`/`writeFile`/`rename`, `fetch`); `src/cli/testkit.ts` (`fakeIo()`: in-memory
files/modes, `bins`, `canned` shell answers keyed by argv prefix, scripted `answers`, recorded
`calls`/`lines`/`errors`/`questions`); `src/cli/main.ts` (`export async function main(argv, io)`,
first argument picks the command; `version`/`--version`/`-v`, `help`/`--help`/`-h`, unknown → 2;
`if (import.meta.main) process.exit(await main(...))`). Test: `src/cli/main.test.ts` (5).

### Task 8: `plugin install|update|status` — DONE

**Files:** `src/cli/plugin.ts` — `MARKETPLACE_SOURCE = "owds-inc/kairoku"`, `MARKETPLACE =
"kairoku-marketplace"`, `PLUGIN = "kairoku@kairoku-marketplace"`; `install` = marketplace list
(skip add when the name is registered, whatever its source) → add → plugin list (skip when
installed) → `install --scope user`; `update` = `marketplace update` → `plugin update -y`;
`status` from `plugin list --json`; `installedPlugin(io)` shared with doctor; no `claude` on PATH →
`CLAUDE_MISSING` (npm and native installer lines), exit 1. Test: `src/cli/plugin.test.ts` (10).

### Task 9: `doctor` — DONE

**Files:** `src/cli/doctor.ts` — `Check = { name, status: PASS|WARN|FAIL, detail? }`,
`checks(io)`, `run(args, io)` prints one padded line per check and a summary, exit 1 on any FAIL.
Plugin section always (`claude installed`, `kairoku plugin installed`); daemon section only when
`daemonHome(io)` finds `~/.kairoku` or (until Phase 3 migrates) `~/.hikyaku`, else one WARN
`daemon configured` — so a laptop exits 0. Daemon checks ported 1:1: `node ≥ 24`, `bun`/`codex`
installed, `paseo` (WARN), linux-only `PATH export is ~/.bashrc line 1` + `exported dirs exist` +
`userns unrestricted` (absent key = WARN), `codex MCP writes pre-approved`, `config.json`,
`token.env` mode 600, `daemon service` (`systemctl is-active kairoku-daemon` / `launchctl print
gui/<uid>/io.kairoku.daemon`), the 401/200 round trip (token from `KAIROKU_DAEMON_TOKEN=` or
`HIKYAKU_TOKEN=`), linux-only `paseo.service`, `repo present`/`repo clean`. Test:
`src/cli/doctor.test.ts` (9).

### Task 10: `setup` — DONE (daemon half deferred to Phase 3, as the spec's phase order implies)

**Files:** `src/cli/setup.ts` — `parseArgs` over `--plugin --daemon --all --yes/-y --help/-h`;
no selecting flag → two `ask` prompts (`[Y/n]` plugin, `[y/N]` daemon) unless `--yes`, which alone
means `--all`; plugin step = `plugin.run(["install"])`, a failure stops the run; daemon step prints
that it arrives with the next release. Test: `src/cli/setup.test.ts` (10).

### Task 11: `update` — DONE

**Files:** `src/cli/update.ts` — `assetName(platform, arch)` → `kairoku-<os>-<arch>` or null;
execPath under `/Cellar/` → "brew upgrade kairoku", exit 0; GET
`api.github.com/repos/owds-inc/kairoku/releases/latest`; same version → "already the latest";
download asset + `checksums.txt`, sha256 via `node:crypto` must match the asset's line; write
`<execPath>.new` mode 755 then rename over `execPath`; every failure exits 1 without touching the
binary. Test: `src/cli/update.test.ts` (8).

### Task 12: release build, CI, install script, formula — DONE

**Files:** `scripts/build-release.ts` (`bun run build:release`: four `bun build --compile
--target=bun-<os>-<arch>` runs → `dist/kairoku-<os>-<arch>`, `dist/checksums.txt` in sha256sum
format, `dist/kairoku.rb` rendered by `formula(version, sha256s)` so the tap never carries a
hand-typed hash); `.github/workflows/ci.yml` (PRs + main: `bun install`, `bun test`, `bunx tsc
--noEmit`, host-target build + `version`); `.github/workflows/release.yml` (`v*` tag; asserts the tag
equals `v<package.json version>`; suite, tsc, `build:release`, `gh release create` with the four
binaries, `checksums.txt` and `kairoku.rb`); `install.sh` (POSIX sh; `uname` → asset; downloads
from `releases/latest/download/` or `KAIROKU_RELEASE_URL`; awk match in `checksums.txt`;
`sha256sum`/`shasum -a 256`; `/usr/local/bin` if writable else `~/.local/bin`, or
`KAIROKU_INSTALL_DIR`; prints the PATH hint and `next: kairoku setup`); `dist/` ignored.
`Formula/kairoku.rb` in `owds-inc/homebrew-tap` on branch `kairoku-0.1.0` (the tap's `main` seeded
with a README first — it was empty). Test: `src/cli/install-script.test.ts` (3, against a local
`Bun.serve` release: happy path 755 + messages, checksum mismatch, missing entry).

**Done-condition, run on this Mac (arm64):** `bun run build:release` → the four Mach-O/ELF
binaries + `checksums.txt` + `kairoku.rb`; `./dist/kairoku-darwin-arm64 version` → `kairoku 0.1.0`;
`./dist/kairoku-darwin-arm64 setup --plugin --yes` → exit 0 (marketplace and plugin already
present, left alone); `./dist/kairoku-darwin-arm64 doctor` → exit 0 (plugin PASS ×2, daemon WARN).
Formula: `brew audit --strict owds-inc/tap/kairoku` + `brew style`, then a local install of a
`file://`-URL copy pointing at `dist/`, `brew test`, `kairoku version`, uninstall — what waits on
Neil's visibility flip and the `v0.1.0` tag is the same install against the public release assets,
and the released `kairoku.rb`'s checksums replacing the local build's in the tap.

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
