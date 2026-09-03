/**
 * The provider registry, and where the plugin lives.
 *
 * Two providers, built once per daemon: the SDK one and the codex one. The
 * registry exists so `models.ts` and `dispatch.ts` name a provider by the same
 * string the app stores on the dispatch's `team.roles`, and so a claim naming a
 * provider this machine does not have is refused with a reason rather than
 * quietly falling back to the other one.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeProvider, type ClaudeDeps } from "./claude";
import { codexProvider, type CodexDeps } from "./codex";
import type { Provider, ProviderName } from "./types";

export type { Provider, ProviderName, ProviderEvent, RoleRun, LaunchedRun, ProviderExit } from "./types";

export const PROVIDER_NAMES = ["claude", "codex"] as const;

export interface RegistryDeps {
  readonly claude?: ClaudeDeps;
  readonly codex?: CodexDeps;
}

export function providerRegistry(deps: RegistryDeps = {}): Record<ProviderName, Provider> {
  return {
    claude: claudeProvider(deps.claude ?? {}),
    codex: codexProvider(deps.codex ?? {}),
  };
}

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * The Kairoku plugin directory, which is what carries the four role agents, the
 * protocol skills and the MCP server into a Claude run.
 *
 * THE SOURCE TREE FIRST, THE INSTALLED COPY SECOND. Running from a checkout is
 * how this is developed and how the tests see it; a released binary has no
 * `plugin/` beside it, so it looks where `kairoku plugin install` put one.
 *
 * `undefined` is not a failure: the role's own contract is prepended to every
 * prompt regardless (see `roles/`), so a run without the plugin loses the MCP
 * tools and the skills, and says so, rather than losing the role.
 */
export function resolvePluginPath(home = homedir(), moduleDir = import.meta.dir): string | undefined {
  const candidates = [
    join(dirname(dirname(moduleDir)), "..", "plugin"),
    join(home, ".claude", "plugins", "marketplaces", "kairoku-marketplace", "plugin"),
    join(home, ".claude", "plugins", "repos", "owds-inc", "kairoku", "plugin"),
    join(home, ".claude", "plugins", "kairoku"),
  ];
  return candidates.find((path) => existsSync(join(path, ".claude-plugin", "plugin.json")));
}
