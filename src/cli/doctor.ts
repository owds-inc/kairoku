/**
 * `kairoku doctor` — verify this machine, change nothing. PASS / WARN / FAIL
 * per check, nonzero exit on any FAIL. The checks are the bash script's
 * cmd_doctor, ported one for one, with one addition: the plugin section runs
 * everywhere and the daemon section only where a daemon is configured (its
 * config dir exists), so a laptop that only carries the plugin exits 0.
 */

import { join } from "node:path";
import { parseTokenEnv } from "../daemon/config";
import { version, type Io } from "./io";
import { installedPlugin } from "./plugin";

export const usage = `usage: kairoku doctor

  Verifies this machine and changes nothing. One line per check — PASS, WARN
  or FAIL — and a nonzero exit when any check FAILs. The plugin checks run
  everywhere; the daemon checks run where ~/.kairoku (or the pre-rename
  ~/.hikyaku) exists.`;

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

async function http(io: Io, url: string, headers: Record<string, string>) {
  try {
    const r = await io.fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.text() };
  } catch {
    return { status: 0, body: "" };
  }
}

/**
 * The daemon's two-request proof: 401 without the token, 200 with it. `attempts`
 * > 1 waits for a daemon that was just started (500 ms between tries).
 */
export async function roundTrip(io: Io, url: string, token: string, attempts = 1): Promise<Check[]> {
  let anon = await http(io, url, {});
  for (let left = attempts - 1; left > 0 && anon.status === 0; left--) {
    await new Promise((r) => setTimeout(r, 500));
    anon = await http(io, url, {});
  }
  const auth = await http(io, url, { authorization: `Bearer ${token}` });
  return [
    anon.status === 401 ? pass("unauthenticated request refused", "401") : fail("unauthenticated request refused", `got ${anon.status}, expected 401`),
    auth.status === 200 && auth.body.includes('"max"')
      ? pass("authenticated request answers", auth.body)
      : fail("authenticated request answers", `got ${auth.status}: ${auth.body || "<no response>"}`),
  ];
}

export async function checks(io: Io): Promise<Check[]> {
  const out: Check[] = [];

  // -- the plugin, everywhere
  const claude = await version(io, "claude");
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
  }

  // -- the daemon, only where one is configured
  const home = daemonHome(io);
  if (home === null) {
    out.push(warn("daemon configured", "not on this machine — `kairoku setup --daemon` provisions one"));
    return out;
  }

  const node = await version(io, "node");
  const major = Number(node?.replace(/^v/, "").split(".")[0]);
  out.push(major >= NODE_MAJOR ? pass(`node ≥ ${NODE_MAJOR}`, node!) : fail(`node ≥ ${NODE_MAJOR}`, `found ${node ?? "none"}`));
  for (const bin of ["bun", "codex"]) {
    const v = await version(io, bin);
    out.push(v === null ? fail(`${bin} installed`, "not on PATH") : pass(`${bin} installed`, v));
  }
  const paseo = await version(io, "paseo");
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

  const codexConfig = io.readFile(join(io.home, ".codex", "config.toml")) ?? "";
  out.push(
    codexConfig.includes('default_tools_approval_mode = "approve"')
      ? pass("codex MCP writes pre-approved")
      : fail("codex MCP writes pre-approved", 'default_tools_approval_mode = "approve" not set'),
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

  let config: { listen?: { host?: string; port?: number }; repoPath?: string } = {};
  try {
    config = JSON.parse(configText ?? "{}");
  } catch {
    // reported above as present; a malformed file fails the round trip below
  }
  // The token is read and sent, never printed.
  const token = parseTokenEnv(io.readFile(tokenPath) ?? "");
  const { host, port } = config.listen ?? {};
  if (host && port && token) {
    out.push(...(await roundTrip(io, `http://${host}:${port}/capacity`, token)));
  } else {
    out.push(fail("daemon reachable", "cannot test — listen host/port or the token is missing"));
  }

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
