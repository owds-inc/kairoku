/**
 * `kairoku daemon` — the daemon in the foreground (SPEC v0, unchanged), and
 * `daemon install|start|stop|status` around it: a systemd unit on linux
 * (system when passwordless sudo is there, else a user unit with the manual
 * step named). On mac, LaunchAgent label `io.kairoku.daemon` is owned by
 * Rust `kairokud` — Bun `install` refuses to write/bootstrap it; status may
 * still report the label if a Rust agent is loaded. `daemon prune` is the
 * human-run worktree cleanup. Linux install rewrites the unit only when its
 * content changes and never bounces a running daemon whose definition is
 * unchanged.
 */

import { dirname, join } from "node:path";
import { kairokuHome } from "../daemon/config";
import { main as prune } from "../daemon/prune";
import { serve } from "../daemon/server";
import type { Io } from "./io";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, systemdUnit } from "./service";

export const usage = `usage: kairoku daemon [install|start|stop|status|prune]

  (no verb)  run the daemon in the foreground until SIGTERM
  install    linux: write the systemd unit and start it (rewritten only when
             content changes; unchanged running daemon left alone).
             mac: refused — io.kairoku.daemon is owned by Rust kairokud
  start      start the service
  stop       stop the service
  status     is the service running? (nonzero when not)
  prune      remove stale run worktrees — asks first, never touches a branch`;

/** PATH for the service: the binary's dir, bun, node's dir, the usual bins. */
export function servicePath(io: Io): string {
  const node = io.which("node");
  const bun = io.which("bun");
  const dirs = [
    dirname(io.execPath),
    join(io.home, ".bun", "bin"),
    bun ? dirname(bun) : "",
    node ? dirname(node) : "",
    io.platform === "darwin" ? "/opt/homebrew/bin" : "",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

type Verb = (io: Io) => Promise<number>;

// ---------------------------------------------------------------- linux

const systemUnitPath = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;
const userUnitPath = (io: Io) => join(io.home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);

async function linuxScope(io: Io, installing: boolean): Promise<"system" | "user"> {
  if (installing) return (await io.shell(["sudo", "-n", "true"])).code === 0 ? "system" : "user";
  return io.exists(systemUnitPath) ? "system" : "user";
}

const systemctl = (scope: "system" | "user") => (scope === "system" ? ["sudo", "systemctl"] : ["systemctl", "--user"]);

const linux: Record<string, Verb> = {
  async install(io) {
    const scope = await linuxScope(io, true);
    const path = scope === "system" ? systemUnitPath : userUnitPath(io);
    const user = io.env.USER ?? "";
    const text = systemdUnit({ scope, execPath: io.execPath, user, path: servicePath(io) });
    const ctl = systemctl(scope);
    if (io.readFile(path) === text) {
      const active = (await io.shell([...ctl, "is-active", SYSTEMD_UNIT])).stdout.trim();
      if (active === "active") {
        io.out(`unit unchanged and ${SYSTEMD_UNIT} active — left running`);
        return 0;
      }
      io.out("unit unchanged; starting the daemon");
    } else {
      if (scope === "system") {
        const staged = join(kairokuHome(io.home), `${SYSTEMD_UNIT}.service`);
        io.writeFile(staged, text);
        const cp = await io.shell(["sudo", "cp", staged, path]);
        if (cp.code !== 0) return cp.code;
      } else {
        io.writeFile(path, text);
      }
      const reload = await io.shell([...ctl, "daemon-reload"]);
      if (reload.code !== 0) return reload.code;
      io.out(`unit written to ${path}`);
    }
    const enable = await io.shell([...ctl, "enable", "--now", SYSTEMD_UNIT]);
    if (scope === "user") {
      io.out(`note: no passwordless sudo, so this is a user unit — it runs only while ${user} is logged in unless`);
      io.out(`      lingering is on:  loginctl enable-linger ${user}`);
      io.out("      with passwordless sudo, rerun `kairoku daemon install` for a system unit instead");
    }
    return enable.code;
  },
  async start(io) {
    return (await io.shell([...systemctl(await linuxScope(io, false)), "start", SYSTEMD_UNIT])).code;
  },
  async stop(io) {
    return (await io.shell([...systemctl(await linuxScope(io, false)), "stop", SYSTEMD_UNIT])).code;
  },
  async status(io) {
    const ctl = systemctl(await linuxScope(io, false));
    const active = (await io.shell([...ctl, "is-active", SYSTEMD_UNIT])).stdout.trim() || "not installed";
    const enabled = (await io.shell([...ctl, "is-enabled", SYSTEMD_UNIT])).stdout.trim();
    io.out(`${SYSTEMD_UNIT} ${active}${enabled ? `, ${enabled}` : ""}`);
    return active === "active" ? 0 : 1;
  },
};

// ---------------------------------------------------------------- mac

const plistPath = (io: Io) => join(io.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const target = (io: Io) => `gui/${io.uid}/${LAUNCHD_LABEL}`;
const loaded = async (io: Io) => (await io.shell(["launchctl", "print", target(io)])).code === 0;

/** Documented stop: Rust kairokud owns `io.kairoku.daemon` (Neil Q11 / §80). */
export const MAC_LAUNCHAGENT_INSTALL_STOP =
  `kairoku daemon install: ${LAUNCHD_LABEL} is owned by Rust kairokud — Bun CLI does not install or overwrite that LaunchAgent.\n` +
  `Install the Mac service with kairokud (scripts/install.sh from the kairokud repo, or your kairokud install path).\n` +
  `Do not use \`kairoku daemon install\` for this label.`;

const mac: Record<string, Verb> = {
  async install(io) {
    // Refuse even when a plist already exists — never overwrite a Rust-owned agent.
    io.err(MAC_LAUNCHAGENT_INSTALL_STOP);
    return 1;
  },
  async start(io) {
    const path = plistPath(io);
    if (!io.exists(path)) {
      io.err(
        `no agent at ${path} — install via kairokud (scripts/install.sh); Bun does not own ${LAUNCHD_LABEL}`,
      );
      return 1;
    }
    const argv = (await loaded(io))
      ? ["launchctl", "kickstart", "-k", target(io)]
      : ["launchctl", "bootstrap", `gui/${io.uid}`, path];
    return (await io.shell(argv)).code;
  },
  async stop(io) {
    return (await io.shell(["launchctl", "bootout", target(io)])).code;
  },
  async status(io) {
    const r = await io.shell(["launchctl", "print", target(io)]);
    const state = r.stdout.match(/state = .*/)?.[0] ?? r.stdout.trim().split("\n")[0] ?? "";
    io.out(r.code === 0 ? `${LAUNCHD_LABEL} loaded, ${state}` : `${LAUNCHD_LABEL} not loaded`);
    return r.code;
  },
};

export async function run(args: string[], io: Io): Promise<number> {
  const [verb] = args;
  if (verb === undefined) {
    try {
      return await serve();
    } catch (e) {
      io.err(`kairoku daemon: ${(e as Error).message}`);
      return 1;
    }
  }
  if (verb === "prune") return prune(args.slice(1));
  const table = io.platform === "darwin" ? mac : io.platform === "linux" ? linux : null;
  const fn = table?.[verb];
  if (!fn) {
    io.err(table ? usage : `kairoku daemon: no service support for ${io.platform}\n\n${usage}`);
    return 2;
  }
  return fn(io);
}
