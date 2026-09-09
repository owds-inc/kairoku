/**
 * The daemon as a service: the systemd unit (linux) and helpers for the
 * launchd agent label (mac). Neither carries the token — the daemon reads
 * `token.env` beside its config — so the files hold nothing secret.
 *
 * Mac LaunchAgent label `io.kairoku.daemon` is owned by Rust `kairokud`
 * (Neil Q11 / DECISIONS §80). Bun CLI must not install or overwrite that
 * label for MVP — `kairoku daemon install` refuses on darwin. The constant
 * and `launchdPlist` remain so status/doctor can still report a Rust-owned
 * agent already loaded, and tests can assert the historical Bun plist shape.
 */

export const SYSTEMD_UNIT = "kairoku-daemon";
/** Rust kairokud owns this LaunchAgent label; Bun install refuses to claim it. */
export const LAUNCHD_LABEL = "io.kairoku.daemon";

export function systemdUnit(o: { scope: "system" | "user"; execPath: string; user: string; path: string }): string {
  return [
    "[Unit]",
    "Description=Kairoku daemon",
    "After=network-online.target",
    "",
    "[Service]",
    ...(o.scope === "system" ? [`User=${o.user}`] : []),
    `Environment=PATH=${o.path}`,
    `ExecStart=${o.execPath} daemon`,
    "Restart=on-failure",
    "",
    "[Install]",
    `WantedBy=${o.scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(o: { execPath: string; home: string; path: string }): string {
  const log = xml(`${o.home}/.kairoku/daemon.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(o.execPath)}</string>
\t\t<string>daemon</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${xml(o.home)}</string>
\t\t<key>PATH</key>
\t\t<string>${xml(o.path)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
</dict>
</plist>
`;
}
