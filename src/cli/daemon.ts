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
 *
 * FRV09: Rust metadata alone does not switch the facade while a Bun predecessor
 * remains. Lifecycle/foreground route to Rust only after a completed handoff
 * receipt, or when predecessor absence is positively established. Unreadable
 * predecessor inventory blocks. Explicit `migrate`/`cutover` drives handoff;
 * install/setup never silently cut over.
 */

import { dirname, join } from "node:path";
import { isLoopbackHost, kairokuHome } from "../daemon/config";
import { main as prune } from "../daemon/prune";
import { serve } from "../daemon/server";
import type { Io } from "./io";
import {
  handoffComplete,
  inventoryPredecessor,
  runMigration,
} from "./migration";
import { resolveRuntime, type Installation } from "./runtime";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, systemdUnit } from "./service";

export const usage = `usage: kairoku daemon [install|start|stop|status|drain|update|prune|migrate]

  (no verb)  run the resolved daemon in the foreground until SIGTERM
  install    install/enable the resolved Rust service when present; else
             linux Bun systemd (mac Bun LaunchAgent remains refused)
  start      start the resolved service
  stop       stop the resolved service
  status     is the service running? (nonzero when not)
  drain      latch local claim drain and acknowledge cloud drain; heartbeat,
             flush and cancellation continue
  update     ask the live Rust daemon to check for an update (system.requestUpdate)
  prune      remove stale Bun run worktrees — blocked against Rust data roots
  migrate    inventory/drain/reconcile Bun→Rust handoff (add --cutover only when
             a human directs disable of the inventoried predecessor)`;

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

/**
 * Whether CLI lifecycle/foreground may use the resolved Rust installation.
 * Fresh installs (no predecessor) are admitted; dual-runtime waits for handoff.
 */
export function admitRustFacade(io: Io): { ok: true } | { ok: false; reason: string } {
  if (handoffComplete(io)) return { ok: true };
  const predecessor = inventoryPredecessor(io);
  if (predecessor === "unknown") {
    return { ok: false, reason: "unreadable predecessor inventory — cannot switch facade" };
  }
  if (predecessor === null) return { ok: true };
  return {
    ok: false,
    reason:
      "legacy predecessor present — complete `kairoku daemon migrate --cutover` before switching the facade",
  };
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

async function drainLegacy(io: Io): Promise<number> {
  const home = kairokuHome(io.home);
  let host = "127.0.0.1";
  let port = 7801;
  try {
    const parsed = JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as {
      listen?: { host?: string; port?: number };
    };
    host = parsed.listen?.host ?? host;
    port = parsed.listen?.port ?? port;
  } catch {
    io.err("kairoku daemon drain: unreadable config.json");
    return 1;
  }
  if (!isLoopbackHost(host)) {
    io.err("kairoku daemon drain: listener is not loopback");
    return 1;
  }
  const tokenPath = join(home, "drain.token");
  const token = io.readFile(tokenPath)?.trim() ?? "";
  const fileMode = io.mode(tokenPath);
  const dirMode = io.mode(home);
  if (!/^[0-9a-f]{64}$/.test(token) || fileMode !== 0o600 || dirMode !== 0o700) {
    io.err("kairoku daemon drain: drain.token missing or unsafe");
    return 1;
  }
  try {
    const res = await io.fetch(`http://${host}:${port}/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    if (body) io.out(body.trimEnd());
    return res.ok ? 0 : 1;
  } catch (e) {
    io.err(`kairoku daemon drain: ${(e as Error).message}`);
    return 1;
  }
}

async function drainCommand(io: Io): Promise<number> {
  let installation = null;
  try {
    installation = await resolveRuntime(io);
  } catch (e) {
    io.err(`kairoku daemon drain: ${(e as Error).message}`);
    return 1;
  }
  // Dual-runtime / incomplete handoff: drain the Bun predecessor, not Rust.
  const admit = admitRustFacade(io);
  if (installation && admit.ok) {
    const bin = io.which("kairokud") ?? installation.executable;
    const result = await io.shell([bin, "drain", "--json"]);
    if (result.stdout.trim()) io.out(result.stdout.trim());
    if (result.code !== 0 && result.stderr.trim()) io.err(result.stderr.trim());
    return result.code;
  }
  return drainLegacy(io);
}

async function migrateCommand(args: string[], io: Io): Promise<number> {
  const cutover = args.includes("--cutover");
  let installation = null;
  try {
    installation = await resolveRuntime(io);
  } catch (e) {
    io.err(`kairoku daemon migrate: ${(e as Error).message}`);
    return 1;
  }
  if (!installation) {
    io.err("kairoku daemon migrate: no resolved Rust installation — install kairokud first");
    return 1;
  }
  const result = await runMigration(io, installation, { cutover });
  io.out(JSON.stringify(result));
  return result.state === "blocked" ? 1 : 0;
}

async function pruneCommand(args: string[], io: Io): Promise<number> {
  let installation = null;
  try {
    installation = await resolveRuntime(io);
  } catch (e) {
    io.err(`kairoku daemon prune: ${(e as Error).message}`);
    return 1;
  }
  if (installation) {
    io.err(
      `kairoku daemon prune: Rust data root ${installation.dataRoot} is blocked pending deletion-policy review`,
    );
    return 1;
  }
  return prune(args);
}

async function updateCommand(io: Io): Promise<number> {
  let installation = null;
  try {
    installation = await resolveRuntime(io);
  } catch (e) {
    io.err(`kairoku daemon update: ${(e as Error).message}`);
    return 1;
  }
  if (!installation) {
    io.err("kairoku daemon update: no resolved Rust installation — install kairokud first");
    return 1;
  }
  const bin = io.which("kairokud") ?? installation.executable;
  // Delegate to the existing Rust updater surface — never a second updater.
  const result = await io.shell([bin, "call", "system.requestUpdate", "--params", "{}"]);
  if (result.stdout.trim()) io.out(result.stdout.trim());
  if (result.code !== 0 && result.stderr.trim()) io.err(result.stderr.trim());
  return result.code;
}

async function rustForeground(io: Io, installation: Installation): Promise<number> {
  const bin = io.which("kairokud") ?? installation.executable;
  const result = await io.shell([bin, "serve"]);
  if (result.code !== 0 && result.stderr.trim()) io.err(result.stderr.trim());
  return result.code;
}

async function rustLifecycle(verb: string, installation: Installation, io: Io): Promise<number> {
  const { manager, scope, label } = installation.service;
  if (manager === "launchd") {
    const path = join(io.home, "Library", "LaunchAgents", `${label}.plist`);
    const target = `gui/${io.uid}/${label}`;
    const loaded = async () => (await io.shell(["launchctl", "print", target])).code === 0;
    if (verb === "install") {
      if (!io.exists(path)) {
        io.err(
          `kairoku daemon install: no agent at ${path} — install via kairokud package (scripts/install.sh / brew)`,
        );
        return 1;
      }
      if (await loaded()) {
        io.out(`${label} already loaded — left running`);
        return 0;
      }
      return (await io.shell(["launchctl", "bootstrap", `gui/${io.uid}`, path])).code;
    }
    if (verb === "start") {
      if (!io.exists(path)) {
        io.err(`no agent at ${path} — install via kairokud package first`);
        return 1;
      }
      const argv = (await loaded())
        ? ["launchctl", "kickstart", "-k", target]
        : ["launchctl", "bootstrap", `gui/${io.uid}`, path];
      return (await io.shell(argv)).code;
    }
    if (verb === "stop") {
      return (await io.shell(["launchctl", "bootout", target])).code;
    }
    if (verb === "status") {
      const r = await io.shell(["launchctl", "print", target]);
      const state = r.stdout.match(/state = .*/)?.[0] ?? r.stdout.trim().split("\n")[0] ?? "";
      io.out(r.code === 0 ? `${label} loaded, ${state}` : `${label} not loaded`);
      return r.code;
    }
  } else {
    const ctl = scope === "system" ? ["sudo", "systemctl"] : ["systemctl", "--user"];
    if (verb === "install") {
      const enable = await io.shell([...ctl, "enable", "--now", label]);
      if (enable.code === 0) io.out(`enabled ${label} (${scope})`);
      return enable.code;
    }
    if (verb === "start") return (await io.shell([...ctl, "start", label])).code;
    if (verb === "stop") return (await io.shell([...ctl, "stop", label])).code;
    if (verb === "status") {
      const active = (await io.shell([...ctl, "is-active", label])).stdout.trim() || "not installed";
      const enabled = (await io.shell([...ctl, "is-enabled", label])).stdout.trim();
      io.out(`${label} ${active}${enabled ? `, ${enabled}` : ""}`);
      return active === "active" ? 0 : 1;
    }
  }
  io.err(usage);
  return 2;
}

export async function run(args: string[], io: Io): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "prune") return pruneCommand(rest, io);
  if (verb === "drain") return drainCommand(io);
  if (verb === "update") return updateCommand(io);
  if (verb === "migrate") return migrateCommand(rest, io);

  let installation = null;
  try {
    installation = await resolveRuntime(io);
  } catch (e) {
    io.err(`kairoku daemon: ${(e as Error).message}`);
    return 1;
  }

  // FRV09/C4: Rust metadata alone must not switch the facade while a predecessor
  // remains, or when predecessor inventory is unreadable.
  let useRust = false;
  if (installation) {
    const admit = admitRustFacade(io);
    if (admit.ok) {
      useRust = true;
    } else if (verb === undefined || verb === "install") {
      io.err(`kairoku daemon: ${admit.reason}`);
      return 1;
    } else if (verb === "start") {
      // Keep Bun start available so the predecessor stays operable; surface the gate.
      io.err(`kairoku daemon: ${admit.reason}`);
    }
  }

  if (verb === undefined) {
    if (useRust && installation) return rustForeground(io, installation);
    try {
      return await serve();
    } catch (e) {
      io.err(`kairoku daemon: ${(e as Error).message}`);
      return 1;
    }
  }

  if (useRust && installation) return rustLifecycle(verb, installation, io);

  const table = io.platform === "darwin" ? mac : io.platform === "linux" ? linux : null;
  const fn = table?.[verb];
  if (!fn) {
    io.err(table ? usage : `kairoku daemon: no service support for ${io.platform}\n\n${usage}`);
    return 2;
  }
  return fn(io);
}
