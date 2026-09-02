/**
 * `kairoku setup` — the wizard (or the flags) that sets up the Claude Code
 * plugin and/or the orchestration daemon on this machine. The daemon half is
 * the bash script's `setup`, step for step (provision.ts), then the service
 * (daemon.ts) and the doctor's round trip.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { kairokuHome, migrateHome, parseTokenEnv } from "../daemon/config";
import * as daemonCmd from "./daemon";
import { roundTrip } from "./doctor";
import type { Io } from "./io";
import * as plugin from "./plugin";
import {
  appCheckoutDir,
  checkout,
  codexConfig,
  configuredRepoUrl,
  daemonConfig,
  DEFAULT_APP_REPO,
  remainder,
  runtimes,
  shellPath,
  userns,
  type Step,
} from "./provision";

export const usage = `usage: kairoku setup [--plugin] [--daemon] [--all] [--yes] [--repo <url>]

  Without flags, a wizard asks what to set up.
  --plugin       install the Claude Code plugin (= kairoku plugin install)
  --daemon       provision this machine for the orchestration daemon and
                 install its service — idempotent, safe on a live machine
  --all          both
  --yes, -y      no prompts; alone it means --all
  --repo <url>   the app repo to clone as the worktree base (asked once,
                 then remembered as repoUrl in ~/.kairoku/config.json)`;

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      plugin: { type: "boolean" },
      daemon: { type: "boolean" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      repo: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }).values;
}

async function confirm(io: Io, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await io.ask(question)).toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

const mark = { done: "✔", skipped: "–", manual: "!" } as const;

export async function daemon(io: Io, opts: { yes: boolean; repo?: string }): Promise<number> {
  io.out("== daemon");
  const steps: Step[] = [];
  const show = (s: Step) => {
    steps.push(s);
    io.out(`   ${mark[s.outcome]} ${s.name} — ${s.detail}`);
  };
  // Before anything else writes ~/.kairoku: a pre-rename ~/.hikyaku is copied
  // first, so its token and config are what the steps below find — not a
  // freshly minted token beside an abandoned one.
  if (migrateHome(io.home) === "migrated") {
    show({ name: "pre-rename config dir", outcome: "done", detail: "migrated ~/.hikyaku to ~/.kairoku (copied; the old dir is untouched)" });
  }
  for (const s of await runtimes(io)) show(s);
  show(await shellPath(io));

  let repoUrl = opts.repo ?? configuredRepoUrl(io);
  if (!repoUrl) {
    repoUrl = opts.yes ? DEFAULT_APP_REPO : (await io.ask(`App repo to clone as the worktree base [${DEFAULT_APP_REPO}]: `)) || DEFAULT_APP_REPO;
  }
  show(await checkout(io, repoUrl));
  show(await userns(io));
  show(await codexConfig(io));
  for (const s of await daemonConfig(io, appCheckoutDir(io), repoUrl)) show(s);

  io.out("== daemon service");
  const service = await daemonCmd.run(["install"], io);
  if (service !== 0) return service;

  const home = kairokuHome(io.home);
  let listen: { host?: string; port?: number } = {};
  try {
    listen = (JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as { listen?: typeof listen }).listen ?? {};
  } catch {
    // reported by the round trip below
  }
  const token = parseTokenEnv(io.readFile(join(home, "token.env")) ?? "") ?? "";
  const checks = await roundTrip(io, `http://${listen.host}:${listen.port}/capacity`, token, 10);
  for (const c of checks) io.out(`   ${c.status}  ${c.name.padEnd(34)} ${c.detail ?? ""}`.trimEnd());

  const owed = remainder(io, steps);
  io.out("");
  io.out(owed.length ? "== done. What is left is human-only:\n" : "== done. Nothing human-only is outstanding on this machine.");
  for (const item of owed) io.out(`  ${item}`);
  io.out("\n  At dispatch time: export KAIROKU_PAT=…  (the slot PAT — never stored here)\n\nThen: kairoku doctor");
  return checks.every((c) => c.status === "PASS") ? 0 : 1;
}

export async function run(args: string[], io: Io): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(args);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${usage}`);
    return 2;
  }
  if (values.help) {
    io.out(usage);
    return 0;
  }
  let wantPlugin = Boolean(values.plugin || values.all);
  let wantDaemon = Boolean(values.daemon || values.all);
  if (!wantPlugin && !wantDaemon) {
    if (values.yes) {
      wantPlugin = wantDaemon = true;
    } else {
      wantPlugin = await confirm(io, "Install the Claude Code plugin? [Y/n] ", true);
      wantDaemon = await confirm(io, "Set up the orchestration daemon on this machine? [y/N] ", false);
    }
  }
  if (!wantPlugin && !wantDaemon) {
    io.out("nothing selected");
    return 0;
  }
  if (wantPlugin) {
    io.out("== Claude Code plugin");
    const code = await plugin.run(["install"], io);
    if (code !== 0) return code;
  }
  if (wantDaemon) return daemon(io, { yes: Boolean(values.yes), repo: values.repo });
  return 0;
}
