/**
 * §20.11 — the SERVICES a run gets: its own ports, its own compose project.
 *
 * Docker Compose is the one service engine, and every run gets a project of its
 * own (`kairoku-<runId>`) so that two members on one machine share nothing: not
 * a container, not a network, and — because the volumes are declared without a
 * `name:` and torn down with `-v` — not a byte of data either.
 *
 * PORTS ARE ALLOCATED, NOT CONFIGURED. A bind probe finds a free number in the
 * operator's range and a PROCESS-WIDE RESERVATION holds it, because the probe
 * has to close the socket before compose can open it and the next member of the
 * same daemon would otherwise probe the same free number a millisecond later.
 * The reservation is this daemon's; two daemons sharing a machine still race,
 * which is what the compose failure is for.
 *
 * Everything binds 127.0.0.1. The daemon passes the numbers; the bind address
 * lives in the repo's own compose file, which is the only place that can know
 * which interface a service belongs on.
 */

import { run as execArgv, type CommandResult } from "./worktree";

export const DEFAULT_PORT_RANGE = "20000-29999";

export interface PortRange {
  readonly from: number;
  readonly to: number;
}

/**
 * `"20000-29999"`. Anything else is `undefined` rather than a partial reading:
 * a range that silently became `20000-20000` is one port for a whole machine,
 * and the failure would look like flaky compose rather than a typo in a config.
 */
export function parsePortRange(text: string): PortRange | undefined {
  const match = text.trim().match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1024 || to > 65535 || from > to) return undefined;
  return { from, to };
}

export interface PortDeps {
  /** True when nothing is listening on 127.0.0.1:port right now. */
  probe(port: number): boolean;
}

const bindProbe: PortDeps = {
  probe(port) {
    try {
      const socket = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      socket.stop(true);
      return true;
    } catch {
      return false;
    }
  },
};

/** Held by a live run of THIS daemon. Released at teardown, on every exit path. */
const held = new Set<number>();

/** The reservations currently held. A test seam and a `/status` line. */
export function reserved(): number[] {
  return [...held];
}

/**
 * One free port per name. The scan starts at a random offset so that a daemon
 * restarting into a machine whose first hundred ports are busy does not walk
 * the same dead prefix every time.
 */
export function allocatePorts(
  names: readonly string[],
  range: PortRange,
  deps: PortDeps = bindProbe,
): Record<string, number> {
  const out: Record<string, number> = {};
  const span = range.to - range.from + 1;
  for (const name of names) {
    const start = Math.floor(Math.random() * span);
    let found: number | undefined;
    for (let i = 0; i < span; i++) {
      const port = range.from + ((start + i) % span);
      if (held.has(port) || !deps.probe(port)) continue;
      found = port;
      held.add(port);
      break;
    }
    if (found === undefined) {
      releasePorts(out);
      throw new Error(`no free port for ${name} in ${range.from}-${range.to} — widen \`ports\` in config.json`);
    }
    out[name] = found;
  }
  return out;
}

export function releasePorts(ports: Record<string, number>): void {
  for (const port of Object.values(ports)) held.delete(port);
}

// ------------------------------------------------------------------ compose

/** Compose accepts `[a-z0-9][a-z0-9_-]*` and nothing else. */
export function projectName(runId: string): string {
  return `kairoku-${runId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
}

/** The prefix `kairoku daemon prune` offers. The bare `kairoku` is NOT one of ours. */
const PER_RUN_PROJECT = /^kairoku-.+/;

export interface ComposeSpec {
  readonly project: string;
  /** Relative to `cwd`. Absent for a project prune reaches by label alone. */
  readonly file?: string;
  readonly cwd: string;
  /** The run's whole environment — compose reads the port names out of it. */
  readonly env: Record<string, string>;
}

export interface ComposeDeps {
  exec(argv: string[], cwd: string, env?: Record<string, string>): Promise<CommandResult>;
}

const realDocker: ComposeDeps = { exec: (argv, cwd, env) => execArgv(argv, cwd, env) };

export interface ComposeResult {
  readonly ok: boolean;
  readonly summary: string;
}

function argv(spec: ComposeSpec, rest: string[]): string[] {
  return ["docker", "compose", "-p", spec.project, ...(spec.file ? ["-f", spec.file] : []), ...rest];
}

/** The last `lines` lines of whatever docker said, so a failure names itself. */
function tail(result: CommandResult, lines = 20): string {
  return `${result.stdout}${result.stderr}`.trim().split("\n").slice(-lines).join("\n").slice(0, 1000);
}

/**
 * `up --wait`, which is the whole reason a repo declares healthchecks: without
 * it a service counts as started the instant its entrypoint forks, and the
 * run's first migration races the container's boot.
 */
export async function composeUp(spec: ComposeSpec, deps: ComposeDeps = realDocker): Promise<ComposeResult> {
  const result = await deps
    .exec(argv(spec, ["up", "--wait"]), spec.cwd, spec.env)
    .catch((err: unknown) => ({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  return result.code === 0
    ? { ok: true, summary: `compose ${spec.project} up` }
    : { ok: false, summary: `compose up failed for ${spec.project}: ${tail(result)}` };
}

/** `-v`: the project's volumes go with it, or the next run inherits this one's data. */
export async function composeDown(spec: ComposeSpec, deps: ComposeDeps = realDocker): Promise<ComposeResult> {
  const result = await deps
    .exec(argv(spec, ["down", "-v", "--remove-orphans"]), spec.cwd, spec.env)
    .catch((err: unknown) => ({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  return result.code === 0
    ? { ok: true, summary: `compose ${spec.project} down` }
    : { ok: false, summary: `compose down failed for ${spec.project}: ${tail(result)}` };
}

/**
 * Per-run compose projects on this machine, running or stopped. A machine with
 * no docker answers with an empty list rather than a throw: `prune` and
 * `doctor` both ask, and neither should fall over on a laptop that only carries
 * the plugin.
 */
export async function composeProjects(deps: ComposeDeps = realDocker): Promise<string[]> {
  const result = await deps
    .exec(["docker", "compose", "ls", "-a", "-q"], process.cwd())
    .catch(() => ({ code: 127, stdout: "", stderr: "" }));
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => PER_RUN_PROJECT.test(name));
}

/** The `docker compose version` line, or `undefined` when docker is not usable here. */
export async function dockerVersion(deps: ComposeDeps = realDocker): Promise<string | undefined> {
  const result = await deps
    .exec(["docker", "compose", "version"], process.cwd())
    .catch(() => ({ code: 127, stdout: "", stderr: "" }));
  return result.code === 0 ? result.stdout.trim().split("\n")[0] : undefined;
}
