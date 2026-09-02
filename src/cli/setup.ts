/**
 * `kairoku setup` — the wizard (or the flags) that sets up the Claude Code
 * plugin and/or the orchestration daemon on this machine.
 */

import { parseArgs } from "node:util";
import type { Io } from "./io";
import * as plugin from "./plugin";

export const usage = `usage: kairoku setup [--plugin] [--daemon] [--all] [--yes]

  Without flags, a wizard asks what to set up.
  --plugin    install the Claude Code plugin (= kairoku plugin install)
  --daemon    set up the orchestration daemon on this machine
  --all       both
  --yes, -y   no prompts; alone it means --all`;

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      plugin: { type: "boolean" },
      daemon: { type: "boolean" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  }).values;
}

async function confirm(io: Io, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await io.ask(question)).toLowerCase();
  return answer === "" ? fallback : answer.startsWith("y");
}

/** Phase 3 ports the machine steps; until then the flag is honoured with a notice. */
export async function daemon(io: Io): Promise<number> {
  io.out("== daemon");
  io.out("the daemon setup (config, token, service, machine steps) arrives with the next release;");
  io.out("until then a VM is provisioned with the repo's ./hikyaku script.");
  return 0;
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
  if (wantDaemon) return daemon(io);
  return 0;
}
