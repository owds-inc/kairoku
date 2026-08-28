/**
 * RF-009 — roles are a fixed table in the daemon.
 *
 * v0 ships `executor` only. An undeclared role is `unknown_role`. All command
 * construction lives here; nothing else in the daemon knows how to build an
 * agent command line. Tests substitute a stub through `Config.commandOverride`
 * (test-only config), never through a test-mode role.
 */

export type RoleName = "executor";

export interface Role {
  readonly provider: string;
  readonly build: (spec: CommandSpec) => string[];
}

/** Everything the role table needs to turn a run request into an argv array. */
export interface CommandSpec {
  readonly role: string;
  readonly model?: string;
  /** Absolute path of the run's worktree — the agent's working root. */
  readonly cwd: string;
}

/**
 * `codex exec --json`, run-to-completion.
 *
 * Flags verified against codex-cli 0.150.1 (`codex exec --help`):
 *   --json                 print events to stdout as JSONL
 *   -s, --sandbox <MODE>   read-only | workspace-write | danger-full-access
 *   -c key=value           override a config value (TOML-parsed)
 *   -C, --cd <DIR>         working root
 *   -m, --model <MODEL>    model override
 *
 * The brief is NOT passed as the positional PROMPT argument: codex reads
 * instructions from stdin when no prompt is given, which keeps briefs out of
 * the process table and out of reach of argv parsing (a brief beginning with
 * `-` would otherwise be read as a flag).
 */
const executor: Role = {
  provider: "codex",
  build: (spec) => {
    const argv = [
      "codex",
      "exec",
      "--json",
      "-s",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-C",
      spec.cwd,
    ];
    if (spec.model) argv.push("-m", spec.model);
    return argv;
  },
};

const ROLES: Record<RoleName, Role> = { executor };

export function getRole(name: string): Role | undefined {
  return Object.prototype.hasOwnProperty.call(ROLES, name)
    ? ROLES[name as RoleName]
    : undefined;
}

export function roleNames(): string[] {
  return Object.keys(ROLES);
}
