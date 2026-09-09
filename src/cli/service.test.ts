import { describe, expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "./service";

describe("service files", () => {
  test("systemd system unit runs `kairoku daemon` as the user with an explicit PATH, restarting on failure", () => {
    const unit = systemdUnit({ scope: "system", execPath: "/usr/local/bin/kairoku", user: "neil", path: "/home/neil/.bun/bin:/usr/bin:/bin" });
    expect(unit).toContain("[Unit]\nDescription=Kairoku daemon\nAfter=network-online.target\n");
    expect(unit).toContain("User=neil\n");
    expect(unit).toContain("Environment=PATH=/home/neil/.bun/bin:/usr/bin:/bin\n");
    expect(unit).toContain("ExecStart=/usr/local/bin/kairoku daemon\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=multi-user.target\n");
    expect(unit.endsWith("\n")).toBe(true);
  });

  test("systemd user unit has no User= and wants default.target", () => {
    const unit = systemdUnit({ scope: "user", execPath: "/home/neil/.local/bin/kairoku", user: "neil", path: "/usr/bin:/bin" });
    expect(unit).not.toContain("User=");
    expect(unit).toContain("WantedBy=default.target\n");
    expect(unit).toContain("ExecStart=/home/neil/.local/bin/kairoku daemon\n");
  });

  test("launchdPlist helper keeps historical Bun shape for label io.kairoku.daemon (install no longer writes it)", () => {
    // Kept for format assertions / doctor label constant; Bun install refuses this label.
    const plist = launchdPlist({ execPath: "/opt/homebrew/bin/kairoku", home: "/Users/neil", path: "/opt/homebrew/bin:/usr/bin:/bin" });
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    expect(plist).toContain("<key>Label</key>\n\t<string>io.kairoku.daemon</string>");
    expect(plist).toContain("<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/homebrew/bin/kairoku</string>\n\t\t<string>daemon</string>\n\t</array>");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>StandardOutPath</key>\n\t<string>/Users/neil/.kairoku/daemon.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>\n\t<string>/Users/neil/.kairoku/daemon.log</string>");
    expect(plist).toContain("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>HOME</key>\n\t\t<string>/Users/neil</string>");
    expect(plist.endsWith("</plist>\n")).toBe(true);
  });
});
