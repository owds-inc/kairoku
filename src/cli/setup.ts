/**
 * `kairoku setup` — the wizard (or the flags) that sets up the Claude Code
 * plugin and/or the orchestration daemon on this machine. The daemon half is
 * the bash script's `setup`, step for step (provision.ts), then the service
 * (daemon.ts) and the doctor's round trip.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { appClient, PROTOCOL_VERSION } from "../daemon/app";
import { kairokuHome, migrateHome, normaliseAppUrl, parseTokenEnv } from "../daemon/config";
import { version as cliVersion } from "../../package.json";
import * as daemonCmd from "./daemon";
import { daemonStatus, reachable } from "./doctor";
import type { Io } from "./io";
import * as plugin from "./plugin";
import {
  appCheckoutDir,
  checkout,
  codexConfig,
  configuredRepoUrl,
  daemonConfig,
  DEFAULT_APP_REPO,
  DEFAULT_APP_URL,
  remainder,
  runtimes,
  shellPath,
  userns,
  writeAppLink,
  type Step,
} from "./provision";

export const usage = `usage: kairoku setup [--plugin] [--daemon] [--all] [--yes] [--repo <url>]
                     [--app-url <url>] [--app-token <token>]

  Without flags, a wizard asks what to set up.
  --plugin       install the Claude Code plugin (= kairoku plugin install)
  --daemon       provision this machine for the orchestration daemon and
                 install its service — idempotent, safe on a live machine
  --all          both
  --yes, -y      no prompts; alone it means --all
  --repo <url>   the app repo to clone as the worktree base (asked once,
                 then remembered as repoUrl in ~/.kairoku/config.json)
  --app-url      the Kairoku app this daemon reports to
  --app-token    its daemon credential — both are printed once by
                 Settings → Daemons in the app`;

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      plugin: { type: "boolean" },
      daemon: { type: "boolean" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      repo: { type: "string" },
      "app-url": { type: "string" },
      "app-token": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }).values;
}

async function confirm(io: Io, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await io.ask(question)).toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

const mark = { done: "✔", skipped: "–", manual: "!" } as const;

/**
 * RF-011 — the app link, written and then PROVED with one heartbeat before the
 * service is installed.
 *
 * Proving it here is the whole point: a token that the app refuses looks
 * exactly like a working one in a config file, and finding that out from a
 * service that quietly does nothing is the failure this step exists to
 * prevent. A 401 stops setup; nothing is installed.
 */
async function appLink(
  io: Io,
  opts: { yes: boolean; appUrl?: string; appToken?: string },
): Promise<{ step: Step; stop?: string }> {
  const name = "app link";
  const home = kairokuHome(io.home);
  const configured = (() => {
    try {
      return (JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as { appUrl?: unknown }).appUrl;
    } catch {
      return undefined;
    }
  })();

  const existingToken = parseTokenEnv(io.readFile(join(home, "token.env")) ?? "");
  let appUrl = opts.appUrl ?? (typeof configured === "string" ? configured : undefined);
  let token = opts.appToken ?? existingToken;

  if (!opts.yes && (!appUrl || !token)) {
    appUrl ||= (await io.ask(`Kairoku app URL [${DEFAULT_APP_URL}]: `)) || DEFAULT_APP_URL;
    // Read, never echoed: the answer goes straight to a 0600 file.
    token ||= await io.ask("Daemon token from Settings → Daemons (kai_…): ");
  }
  if (!appUrl || !token) {
    return {
      step: {
        name,
        outcome: "manual",
        detail:
          "not linked — mint a daemon token in the app under Settings → Daemons, then rerun:\n" +
          "     kairoku setup --daemon --app-url <url> --app-token <kai_…>",
      },
    };
  }

  appUrl = normaliseAppUrl(appUrl);
  // Written first so a failed proof still leaves the operator's own values in
  // place to correct, rather than making them retype both.
  writeAppLink(io, appUrl, token);

  const result = await appClient({ appUrl, token, fetch: io.fetch }).heartbeat({
    meta: {
      protocol: PROTOCOL_VERSION,
      host: io.env.HOSTNAME ?? "this machine",
      version: cliVersion,
      capacity: { running: 0, max: 0 },
    },
  });
  if (!result.ok) return { step: { name, outcome: "manual", detail: result.error }, stop: result.error };
  return { step: { name, outcome: "done", detail: `app link proved — ${appUrl} says ${result.body.liveness}` } };
}

export async function daemon(
  io: Io,
  opts: { yes: boolean; repo?: string; appUrl?: string; appToken?: string },
): Promise<number> {
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

  const link = await appLink(io, { yes: opts.yes, appUrl: opts.appUrl, appToken: opts.appToken });
  show(link.step);
  if (link.stop) {
    // Nothing is installed behind a link that does not work.
    io.out(`\n== stopped: ${link.stop}`);
    io.out("   mint a fresh token in the app under Settings → Daemons and rerun with --app-token");
    return 1;
  }

  io.out("== daemon service");
  const service = await daemonCmd.run(["install"], io);
  if (service !== 0) return service;

  const home = kairokuHome(io.home);
  let listen: { host?: string; port?: number } = {};
  try {
    listen = (JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as { listen?: typeof listen }).listen ?? {};
  } catch {
    // reported by the reachability check below
  }
  const statusUrl = `http://${listen.host ?? "127.0.0.1"}:${listen.port ?? 7801}/status`;
  // Ten tries: the service was started moments ago.
  const check = reachable(statusUrl, await daemonStatus(io, statusUrl, 10));
  io.out(`   ${check.status}  ${check.name.padEnd(34)} ${check.detail ?? ""}`.trimEnd());

  const owed = remainder(io, steps);
  io.out("");
  io.out(owed.length ? "== done. What is left is human-only:\n" : "== done. Nothing human-only is outstanding on this machine.");
  for (const item of owed) io.out(`  ${item}`);
  io.out("\nThen: kairoku doctor");
  return check.status === "PASS" ? 0 : 1;
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
  if (wantDaemon) {
    return daemon(io, {
      yes: Boolean(values.yes),
      repo: values.repo,
      appUrl: values["app-url"],
      appToken: values["app-token"],
    });
  }
  return 0;
}
