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
import type { LaunchedRun, Provider, ProviderName } from "./types";

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
 * THE ONE PRODUCTION CONSTRUCTOR. Every call site in the daemon —
 * `link.ts`, `dispatch.ts`, `models.ts` — builds its providers here and nowhere
 * else; `providerRegistry()` bare is the test seam.
 *
 * It exists because the wiring it does is invisible in a unit test and fatal in
 * production: a `claudeProvider({})` is a perfectly working provider that
 * happens to start every run with no kairoku MCP server, no protocol skills and
 * no role agents. The plugin path and the resolved `claude` are resolved ONCE,
 * here, and handed in.
 */
export function productionProviders(
  config: { readonly pluginPath?: string } = {},
  resolve: () => string | undefined = resolvePluginPath,
): Record<ProviderName, Provider> {
  const pluginPath = config.pluginPath ?? resolve();
  if (pluginPath === undefined) return { claude: refuses("claude", NO_PLUGIN), codex: codexProvider({}) };
  const claudePath = resolveClaudePath();
  return providerRegistry({
    claude: { pluginPath, ...(claudePath === undefined ? {} : { claudePath }) },
  });
}

/**
 * FAIL CLOSED (§20.4's rule applied to the plugin). A role agent is a plugin
 * agent: without the plugin there are no `mcp__kairoku__*` tools — the very
 * tools `policy.ts` allows and the role contracts instruct the agent to call —
 * so a "run" would be a model with the role's prose and none of its reach,
 * reporting progress to nothing. That is worse than a refusal a human can read.
 */
const NO_PLUGIN =
  "no Kairoku plugin on this machine, so a role agent would run with no kairoku MCP tools and no skills — install it with `kairoku plugin install`, or set `pluginPath` in the daemon config";

/** The resolved `claude`, or the SDK's bundled one. Read at CALL time: a service manager sets PATH after import. */
export function resolveClaudePath(): string | undefined {
  return Bun.which("claude", { PATH: process.env.PATH ?? "" }) ?? undefined;
}

/** A provider that runs nothing and says why, on both the event channel and the exit. */
function refuses(name: ProviderName, reason: string): Provider {
  return {
    name,
    async models() {
      // Advertise nothing: the composer greys out what this machine cannot
      // drive, which keeps the work off it rather than failing it on arrival.
      return [];
    },
    launch(): LaunchedRun {
      return {
        events: (async function* () {
          yield { kind: "error" as const, text: reason };
        })(),
        interrupt() {},
        exit: Promise.resolve({ ok: false, summary: reason }),
      };
    },
  };
}

/**
 * The Kairoku plugin directory, which is what carries the four role agents, the
 * protocol skills and the MCP server into a Claude run.
 *
 * THE SOURCE TREE FIRST, THE INSTALLED COPY SECOND. Running from a checkout is
 * how this is developed and how the tests see it; a released binary has no
 * `plugin/` beside it, so it looks where `kairoku plugin install` put one.
 *
 * `undefined` IS a failure on the Claude side: `productionProviders` refuses to
 * launch without it, because a role agent stripped of its MCP tools is not the
 * role. The contract in `roles/` is prepended to every prompt on both providers
 * regardless, so what a codex run loses without a plugin is the tools, never
 * the role.
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
