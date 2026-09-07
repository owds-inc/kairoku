/**
 * `kairoku doctor` — verify this machine, change nothing. PASS / WARN / FAIL
 * per check, nonzero exit on any FAIL. The checks are the bash script's
 * cmd_doctor, ported one for one, with one addition: the plugin section runs
 * everywhere and the daemon section only where a daemon is configured (its
 * config dir exists), so a laptop that only carries the plugin exits 0.
 */

import { join } from "node:path";
import { appClient, PROTOCOL_VERSION } from "../daemon/app";
import { DEFAULT_PORT_RANGE, parsePortRange, type PortDeps } from "../daemon/compose";
import { CODEGRAPH } from "../daemon/codegraph";
import { normaliseAppUrl, parseTokenEnv } from "../daemon/config";
import { availableResolvers } from "../daemon/env";
import { ACTIVE_FLUSH_MS } from "../daemon/link";
import { parseManifest, MANIFEST_FILE } from "../daemon/manifest";
import { AST_GREP, RULES_PATH } from "../daemon/rules";
import { version as binVersion, type Io } from "./io";
import { resolvePluginPath } from "../daemon/providers";
import { installedPlugin, MARKETPLACE, MARKETPLACE_SOURCE } from "./plugin";
import { version as cliVersion } from "../../package.json";

export const usage = `usage: kairoku doctor

  Verifies this machine and changes nothing. One line per check — PASS, WARN
  or FAIL — and a nonzero exit when any check FAILs. The plugin checks run
  everywhere; the daemon checks run where ~/.kairoku (or the pre-rename
  ~/.hikyaku) exists, and they include one real heartbeat to the app.`;

export type Check = { name: string; status: "PASS" | "WARN" | "FAIL"; detail?: string };

export const NODE_MAJOR = 24;
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "./service";

const pass = (name: string, detail?: string): Check => ({ name, status: "PASS", detail });
const warn = (name: string, detail?: string): Check => ({ name, status: "WARN", detail });
const fail = (name: string, detail?: string): Check => ({ name, status: "FAIL", detail });

/** The daemon's config dir: ~/.kairoku, or the pre-rename ~/.hikyaku until Phase 3 migrates it. */
export function daemonHome(io: Io): string | null {
  for (const dir of [".kairoku", ".hikyaku"]) {
    const path = join(io.home, dir);
    if (io.exists(path)) return path;
  }
  return null;
}

/** What `GET /status` answers; only the fields doctor reads are named. */
export interface DaemonStatus {
  version?: string;
  capacity?: { running: number; max: number };
  link?: { linked?: boolean; liveness?: string; stopped?: string; lastError?: string };
  runs?: unknown[];
}

/**
 * Ask the local listener for its status.
 *
 * There is no bearer any more (SPEC v1, RF-006): reachability on the daemon's
 * own address IS the trust boundary, so this is a plain GET. `attempts` > 1
 * waits for a daemon that was just started (500 ms between tries).
 */
export async function daemonStatus(io: Io, url: string, attempts = 1): Promise<DaemonStatus | null> {
  for (let left = attempts; left > 0; left--) {
    try {
      const r = await io.fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return (await r.json()) as DaemonStatus;
    } catch {
      // not listening yet
    }
    if (left > 1) await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export function reachable(url: string, status: DaemonStatus | null): Check {
  return status && status.capacity
    ? pass("daemon reachable", `${url} — ${status.capacity.running}/${status.capacity.max} running`)
    : fail("daemon reachable", `${url} did not answer — is the service running? (kairoku daemon status)`);
}

/**
 * RF-011 — the app link, proved rather than assumed: one real heartbeat with
 * this machine's credential. A configured token that the app refuses is the
 * failure that matters, and it is invisible from the config file alone.
 *
 * The token is read and sent. It is never printed, and the 401 message from
 * `app.ts` deliberately carries only the app URL.
 */
export async function appLink(
  io: Io,
  appUrl: string | undefined,
  token: string | undefined,
  status: DaemonStatus | null,
): Promise<Check[]> {
  if (!appUrl) return [fail("app link", "no appUrl in config.json — run `kairoku setup --daemon`")];
  if (!token) return [fail("app link", "no KAIROKU_DAEMON_TOKEN — run `kairoku setup --daemon`")];

  const result = await appClient({ appUrl: normaliseAppUrl(appUrl), token, fetch: io.fetch }).heartbeat({
    meta: {
      protocol: PROTOCOL_VERSION,
      host: io.env.HOSTNAME ?? "this machine",
      version: cliVersion,
      capacity: status?.capacity ?? { running: 0, max: 0 },
    },
  });

  const runs = status?.runs?.length;
  const inFlight =
    runs === undefined
      ? warn("runs in flight", "unknown — the daemon is not answering")
      : pass("runs in flight", String(runs));
  const linkErrors =
    status === null
      ? warn("link errors", "unknown — the daemon is not answering")
      : status.link?.stopped
        ? fail("link errors", `stopped: ${status.link.stopped} — ${status.link.lastError}`)
        : status.link?.lastError
          ? warn("link errors", status.link.lastError)
          : pass("link errors", "none");

  if (!result.ok) return [fail("app link", result.error), inFlight, linkErrors];
  const protocol = result.body.protocol ? `, protocol ${result.body.protocol}` : "";
  const cadence = `events flush: ${ACTIVE_FLUSH_MS / 1000} s while active`;
  return [pass("app link", `${normaliseAppUrl(appUrl)} — ${result.body.liveness}${protocol}, ${cadence}`), inFlight, linkErrors];
}

const NO_PLUGIN_PATH =
  "no plugin directory on this machine — Claude runs will fail closed; `kairoku plugin install`, or set pluginPath in config.json";

/**
 * The daemon's own plugin resolution, run through `io` rather than the process
 * — so `doctor` reports, and `setup --daemon` records, exactly the directory a
 * launched run would be given, never a second opinion about it.
 */
export async function pluginPathFor(io: Io, configured = configuredPluginPath(io)): Promise<string | undefined> {
  const have = await installedPlugin(io);
  return resolvePluginPath({ configured, home: io.home, installed: () => have?.installPath, exists: io.exists });
}

/** A pluginPath already in config.json, if a daemon is configured here. A candidate: it can go stale. */
export function configuredPluginPath(io: Io): string | undefined {
  const home = daemonHome(io);
  if (home === null) return undefined;
  try {
    const file = JSON.parse(io.readFile(join(home, "config.json")) ?? "{}") as { pluginPath?: unknown };
    return typeof file.pluginPath === "string" ? file.pluginPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * O-4 (§20.11) — can this machine give a run its own environment?
 *
 * Four facts, and each is one a machine can be wrong about silently: docker
 * present but not RUNNING, a port range with nothing free in it, a manifest on
 * the base branch that does not parse, and a `{ref}` nobody here can resolve.
 * Every one of them turns into a failed run on a machine nobody is watching.
 */
export async function environment(io: Io, config: DoctorConfig, probe?: PortDeps): Promise<Check[]> {
  const out: Check[] = [];

  // Docker ABSENT is a WARN: `no manifest → today's behaviour` is still
  // supported, so a machine without it runs repos that declare no services.
  // Docker PRESENT but not answering is a FAIL: that machine will accept work
  // for a repo with a compose profile and fail every one of those runs.
  if (!io.which("docker")) {
    out.push(warn("docker compose", "not installed — a repo with a compose profile cannot run on this machine"));
  } else {
    const version = await io.shell(["docker", "compose", "version"]);
    out.push(
      version.code === 0
        ? pass("docker compose", version.stdout.trim().split("\n")[0])
        : fail("docker compose", (version.stderr || version.stdout).trim().split("\n")[0] || "docker is not answering"),
    );
  }

  const text = typeof config.ports === "string" && config.ports ? config.ports : DEFAULT_PORT_RANGE;
  const range = parsePortRange(text);
  if (!range) {
    out.push(fail("run port range", `"${text}" in config.json is not a range like "${DEFAULT_PORT_RANGE}"`));
  } else {
    const test = probe ?? BIND_PROBE;
    // A handful, not the whole range: the question is "is this range usable",
    // and probing ten thousand ports to answer it is its own kind of wrong.
    let free = 0;
    for (let i = 0; i < 4 && range.from + i <= range.to; i++) if (test.probe(range.from + i)) free++;
    out.push(
      free > 0
        ? pass("run port range", `${text} — ${free} of the first 4 free`)
        : fail("run port range", `${text} — nothing free at the bottom of the range; widen or move it`),
    );
  }

  const repo = config.repoPath ?? join(io.home, "work", "kairoku");
  const branch = config.defaultBranch ?? "main";
  const shown = await io.shell(["git", "-C", repo, "show", `origin/${branch}:${MANIFEST_FILE}`]);
  if (shown.code !== 0) {
    out.push(warn(MANIFEST_FILE, `none on origin/${branch} — runs get today's behaviour (no services, no profile)`));
  } else {
    const parsed = parseManifest(shown.stdout);
    out.push(
      parsed.ok
        ? pass(
            MANIFEST_FILE,
            `origin/${branch} — profiles: ${Object.keys(parsed.manifest.env).join(", ") || "none"}`,
          )
        : fail(MANIFEST_FILE, parsed.error),
    );
  }

  // §21 — the three lines. `ast-grep` and the rule count are read together
  // because neither means anything alone: the binary is only REQUIRED where the
  // configured repo's base branch actually declares rules, and a repo that
  // declares them on a machine without it fails every run closed (§21 Q25).
  const listed = await io.shell(["git", "-C", repo, "ls-tree", "-r", "--name-only", `origin/${branch}`, "--", RULES_PATH]);
  const ruleCount =
    listed.code === 0 ? listed.stdout.split("\n").filter((line) => /\.ya?ml$/i.test(line.trim())).length : 0;
  const astGrep = await binVersion(io, AST_GREP);
  out.push(
    astGrep !== null
      ? pass(AST_GREP, astGrep)
      : ruleCount > 0
        ? fail(
            AST_GREP,
            `not on PATH, and origin/${branch} declares ${ruleCount} rule(s) in ${RULES_PATH} — every run of this repo fails closed`,
          )
        : warn(AST_GREP, `not installed — a repo that declares ${RULES_PATH} cannot run on this machine`),
  );
  out.push(pass("rules on base branch", String(ruleCount)));

  // §21 Q14 — WARN, never FAIL. A machine without a language server still runs
  // every role; the implementer greps for a symbol instead of resolving it.
  const lsp = await binVersion(io, "typescript-language-server");
  out.push(
    lsp !== null
      ? pass("typescript-language-server", lsp)
      : warn("typescript-language-server", "absent — symbols are grepped, not resolved (`kairoku setup --daemon` installs it)"),
  );

  // §21 item 3 — WARN, never FAIL, and that is the difference between the two
  // halves of this ruling: rules are a GATE (a repo that declares them on a
  // machine without ast-grep fails every run closed), CodeGraph is a PROBATION
  // (a repo that opted in on a machine without it runs, slower, and says so).
  const codegraph = await binVersion(io, CODEGRAPH);
  out.push(
    codegraph !== null
      ? pass(CODEGRAPH, codegraph)
      : warn(CODEGRAPH, `absent — a repo whose ${MANIFEST_FILE} lists it under \`intelligence\` runs without the index`),
  );

  const resolvers = availableResolvers((bin) => io.which(bin));
  out.push(
    resolvers.length
      ? pass("secret resolvers", resolvers.join(", "))
      : warn("secret resolvers", "none installed — a run whose secrets arrive as a {ref} will fail (op, aws)"),
  );

  return out;
}

/** The real probe, injectable so a unit test never binds a port. */
const BIND_PROBE: PortDeps = {
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

/** Only the fields the checks read. */
interface DoctorConfig {
  listen?: { host?: string; port?: number };
  appUrl?: string;
  repoPath?: string;
  defaultBranch?: string;
  ports?: string;
}

export async function checks(io: Io, probe?: PortDeps): Promise<Check[]> {
  const out: Check[] = [];

  // -- the plugin, everywhere
  const claude = await binVersion(io, "claude");
  if (claude === null) {
    out.push(fail("claude installed", "not on PATH"));
  } else {
    out.push(pass("claude installed", claude));
    const have = await installedPlugin(io);
    out.push(
      have
        ? pass("kairoku plugin installed", `${have.version ?? "?"} ${have.enabled === false ? "disabled" : "enabled"}`)
        : fail("kairoku plugin installed", "run `kairoku plugin install`"),
    );
    const sourceCheck = "kairoku marketplace source";
    const inspectSource = "could not determine source — check `claude plugin marketplace list --json`";
    try {
      const result = await io.shell(["claude", "plugin", "marketplace", "list", "--json"]);
      const markets = result.code === 0 ? JSON.parse(result.stdout) : null;
      if (!Array.isArray(markets) || markets.some((m) => !m || typeof m.name !== "string")) {
        out.push(warn(sourceCheck, inspectSource));
      } else {
        const market = markets.find((m) => m.name === MARKETPLACE);
        if (!market) {
          out.push(fail(sourceCheck, "not registered — run `kairoku plugin install`"));
        } else if (typeof market.source !== "string" || !market.source ||
          (market.source === "github" && (typeof market.repo !== "string" || !market.repo))) {
          out.push(warn(sourceCheck, inspectSource));
        } else if (market.source === "github" && market.repo === MARKETPLACE_SOURCE) {
          out.push(pass(sourceCheck, MARKETPLACE_SOURCE));
        } else {
          // install() deliberately preserves registrations; doctor only reports the manual repair.
          out.push(fail(sourceCheck, `source is not ${MARKETPLACE_SOURCE} — run ` +
            `\`claude plugin marketplace remove ${MARKETPLACE}\` then \`kairoku plugin install\``));
        }
      }
    } catch {
      out.push(warn(sourceCheck, inspectSource));
    }
    // Installed and FINDABLE are two facts, and they came apart: a machine
    // reported the plugin installed and enabled while every Claude run on it
    // refused, because the daemon looked in directories no install ever writes.
    // This line is the directory a launched run is actually given.
    const path = await pluginPathFor(io);
    out.push(path ? pass("kairoku plugin path", path) : fail("kairoku plugin path", NO_PLUGIN_PATH));
  }

  // -- the daemon, only where one is configured
  const home = daemonHome(io);
  if (home === null) {
    out.push(warn("daemon configured", "not on this machine — `kairoku setup --daemon` provisions one"));
    return out;
  }

  const node = await binVersion(io, "node");
  const major = Number(node?.replace(/^v/, "").split(".")[0]);
  out.push(major >= NODE_MAJOR ? pass(`node ≥ ${NODE_MAJOR}`, node!) : fail(`node ≥ ${NODE_MAJOR}`, `found ${node ?? "none"}`));
  for (const bin of ["bun", "codex"]) {
    const v = await binVersion(io, bin);
    out.push(v === null ? fail(`${bin} installed`, "not on PATH") : pass(`${bin} installed`, v));
  }
  const paseo = await binVersion(io, "paseo");
  out.push(paseo === null ? warn("paseo installed", "absent (cockpit is optional)") : pass("paseo installed", paseo));

  if (io.platform === "linux") {
    // The failure this catches: `ssh host bun --version` finding nothing because
    // the PATH export sits below .bashrc's interactive guard.
    const first = io.readFile(join(io.home, ".bashrc"))?.split("\n")[0] ?? "";
    if (first.startsWith("export PATH=") && first.includes(".bun/bin")) {
      out.push(pass("PATH export is ~/.bashrc line 1"));
      const dirs = first.replace(/^export PATH="/, "").replace(/:\$PATH"$/, "").split(":");
      const missing = dirs.filter((d) => !io.exists(d));
      out.push(missing.length ? fail("exported dirs exist", `missing: ${missing.join(" ")}`) : pass("exported dirs exist"));
    } else {
      out.push(fail("PATH export is ~/.bashrc line 1", `found: ${first || "<empty>"}`));
    }
    // Read /proc rather than shelling out to sysctl: it lives in /usr/sbin and
    // is not on every PATH. Absent key = a kernel without the knob, not a fault.
    const knob = io.readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim();
    out.push(
      knob === undefined
        ? warn("userns unrestricted", "sysctl key absent on this kernel")
        : knob === "0"
          ? pass("userns unrestricted", "sysctl = 0")
          : fail("userns unrestricted", `sysctl = ${knob} (codex sandbox will fail)`),
    );
  }

  // §21 item 5b — this check has FLIPPED. It used to demand
  // `default_tools_approval_mode = "approve"` beside a machine-wide
  // `bearer_token_env_var = "KAIROKU_PAT"`. Both now belong to the RUN, written
  // per dispatch into the worktree's own `.codex/config.toml`. What is wrong
  // here is the bearer still being present: `KAIROKU_PAT` is never set outside a
  // run, and Codex prefers the bearer path once it is configured, so the
  // OPERATOR's own Codex gets 401 and its OAuth login is ignored.
  const codexConfig = io.readFile(join(io.home, ".codex", "config.toml")) ?? "";
  // plugin/codex-manifest — a Codex install of the plugin gets its `kairoku`
  // entry from the PLUGIN's own manifest (Codex ≥ 0.146 infers a Claude-Code
  // marketplace and installs it), not a `[mcp_servers.kairoku]` block in
  // config.toml, so the text check above never sees it at all. `codex mcp get`
  // is the only view that resolves what the entry actually IS — including the
  // defect this lane exists for: Claude Code's `${user_config.kairoku_url}`
  // interpolation has no Codex equivalent, so an out-of-date plugin manifest
  // keeps it as literal text and every MCP call fails on a relative URL.
  let resolvedCodexUrl: string | undefined;
  if (io.which("codex")) {
    try {
      const got = await io.shell(["codex", "mcp", "get", "kairoku", "--json"]);
      resolvedCodexUrl = (JSON.parse(got.stdout) as { transport?: { url?: string } }).transport?.url;
    } catch {
      // no `kairoku` entry, or codex answered something doctor cannot parse —
      // the config.toml text below is still checked.
    }
  }
  const name = "codex MCP is a human login";
  out.push(
    /bearer_token_env_var\s*=\s*"KAIROKU_PAT"/.test(codexConfig)
      ? fail(
          name,
          "the global kairoku entry carries bearer_token_env_var — that variable is only set inside a run, so your own Codex gets 401. `codex mcp remove kairoku`, re-add with no bearer flag, then `codex mcp login kairoku`",
        )
      : resolvedCodexUrl?.includes("${")
        ? fail(
            name,
            `the resolved MCP URL is still the unresolved placeholder "${resolvedCodexUrl}" — the Codex plugin manifest is out of date: \`codex plugin update\` (or reinstall from the marketplace), or set it by hand with \`codex mcp add kairoku --url <app>/api/mcp\``,
          )
        : codexConfig.includes("[mcp_servers.kairoku]") || resolvedCodexUrl !== undefined
          ? pass(name, "OAuth; a run brings its own credential")
          : warn(name, "no kairoku MCP entry — `codex mcp add kairoku --url <app>/api/mcp` then `codex mcp login kairoku`"),
  );

  const configPath = join(home, "config.json");
  const tokenPath = join(home, "token.env");
  const configText = io.readFile(configPath);
  out.push(configText === null ? fail("config.json", `${configPath} absent`) : pass("config.json", configPath));
  const mode = io.mode(tokenPath);
  out.push(
    mode === null
      ? fail("token.env", `${tokenPath} absent`)
      : mode === 0o600
        ? pass("token.env", "mode 600")
        : fail("token.env", `mode ${mode.toString(8)} — must be 600`),
  );

  if (io.platform === "linux") {
    const active = (await io.shell(["systemctl", "is-active", SYSTEMD_UNIT])).stdout.trim();
    const enabled = (await io.shell(["systemctl", "is-enabled", SYSTEMD_UNIT])).stdout.trim();
    out.push(
      active === "active"
        ? pass("daemon service", `${SYSTEMD_UNIT} active, ${enabled}`)
        : fail("daemon service", `${SYSTEMD_UNIT} ${active || "not installed"}`),
    );
  } else {
    const r = await io.shell(["launchctl", "print", `gui/${io.uid}/${LAUNCHD_LABEL}`]);
    out.push(r.code === 0 ? pass("daemon service", `${LAUNCHD_LABEL} loaded`) : fail("daemon service", `${LAUNCHD_LABEL} not loaded`));
  }

  let config: DoctorConfig = {};
  try {
    config = JSON.parse(configText ?? "{}");
  } catch {
    // reported above as present; a malformed file fails the two checks below
  }
  // The token is read and sent, never printed.
  const token = parseTokenEnv(io.readFile(tokenPath) ?? "");
  const { host, port } = config.listen ?? {};
  const statusUrl = host && port ? `http://${host}:${port}/status` : undefined;
  const status = statusUrl ? await daemonStatus(io, statusUrl) : null;
  out.push(
    statusUrl
      ? reachable(statusUrl, status)
      : fail("daemon reachable", "cannot test — listen host/port is missing from config.json"),
  );
  out.push(...(await appLink(io, config.appUrl, token, status)));
  out.push(...(await environment(io, config, probe)));

  if (io.platform === "linux") {
    if (io.exists("/etc/systemd/system/paseo.service")) {
      const active = (await io.shell(["systemctl", "is-active", "paseo"])).stdout.trim();
      out.push(active === "active" ? pass("paseo.service", "active") : fail("paseo.service", active));
    } else if (io.exists(join(io.home, "paseo.service"))) {
      out.push(warn("paseo.service", "staged, not installed (password still to set)"));
    } else {
      out.push(warn("paseo.service", "not configured (cockpit is optional)"));
    }
  }

  const repo = typeof config.repoPath === "string" ? config.repoPath : join(io.home, "work", "kairoku");
  if (io.exists(join(repo, ".git"))) {
    const head = (await io.shell(["git", "-C", repo, "rev-parse", "--short", "HEAD"])).stdout.trim();
    out.push(pass("repo present", `${repo} at ${head}`));
    const dirty = (await io.shell(["git", "-C", repo, "status", "--porcelain"])).stdout.split("\n").filter(Boolean).length;
    out.push(dirty ? warn("repo clean", `${dirty} modified path(s)`) : pass("repo clean"));
  } else {
    out.push(fail("repo present", `${repo} is not a git checkout`));
  }

  return out;
}

export async function run(_args: string[], io: Io): Promise<number> {
  const list = await checks(io);
  for (const c of list) io.out(`   ${c.status}  ${c.name.padEnd(34)} ${c.detail ?? ""}`.trimEnd());
  const failed = list.filter((c) => c.status === "FAIL").length;
  const warned = list.filter((c) => c.status === "WARN").length;
  io.out("");
  if (failed === 0) {
    io.out(`✔ all checks passed${warned ? ` (${warned} warning(s))` : ""}`);
    return 0;
  }
  io.out(`✘ ${failed} check(s) failed`);
  return 1;
}
