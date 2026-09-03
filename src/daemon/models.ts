/**
 * §20 item 2 — what this machine says about itself.
 *
 * The composer in the app greys out every model no online machine advertises,
 * and the claim query offers a dispatch only to a machine that says it holds
 * the repo. Both of those are read from here, so the two rules that keep work
 * off a machine that cannot run it are answered by ASKING THE TOOLS, never by a
 * list in a config file that would drift the first time someone upgrades codex.
 *
 * The model lists are cached for the life of the daemon (a new model is a
 * daemon restart, which is §20.6's ruling), because `supportedModels()` opens a
 * session and `codex debug models` renders a catalog — neither is a thing to do
 * every ten seconds. Capacity is deliberately NOT cached: it is the one number
 * that has to be true right now.
 */

import { hostname } from "node:os";
import { version } from "../../package.json";
import { PROTOCOL_VERSION, type DaemonMeta } from "./app";
import type { Config } from "./config";
import { productionProviders } from "./providers";
import { recipeNames } from "./recipes";
import { originFullName } from "./worktree";

export interface MetaDeps {
  /** `owner/repo` for every checkout this machine holds. */
  readonly repos?: () => Promise<string[]>;
  readonly capacity?: () => { running: number; max: number };
  /** provider name → what it can drive. Absent entries are asked of the registry. */
  readonly models?: Record<string, () => Promise<string[]>>;
}

const cache = new WeakMap<Config, Promise<{ repos: string[]; providers: Record<string, string[]> }>>();

export async function machineMeta(config: Config, deps: MetaDeps = {}): Promise<DaemonMeta> {
  let fixed = cache.get(config);
  if (!fixed) {
    fixed = discover(config, deps);
    cache.set(config, fixed);
  }
  const { repos, providers } = await fixed;
  return {
    protocol: PROTOCOL_VERSION,
    host: hostname(),
    version,
    capacity: deps.capacity?.() ?? { running: 0, max: config.maxConcurrent },
    repos,
    providers,
    recipes: recipeNames(),
  };
}

async function discover(
  config: Config,
  deps: MetaDeps,
): Promise<{ repos: string[]; providers: Record<string, string[]> }> {
  const registry = productionProviders(config);
  const askers: Record<string, () => Promise<string[]>> = {
    claude: () => registry.claude.models(),
    codex: () => registry.codex.models(),
    ...(deps.models ?? {}),
  };
  // Only what deps named, when deps named anything: a test that stubs one
  // provider must not have the other one reach for a real tool.
  const names = deps.models ? Object.keys(deps.models) : Object.keys(askers);

  const providers: Record<string, string[]> = {};
  await Promise.all(
    names.map(async (name) => {
      const models = await askers[name]!().catch(() => []);
      // An EMPTY list is left out rather than sent: "this machine has no codex"
      // and "it has codex and no models" are different facts to the composer.
      if (models.length > 0) providers[name] = models;
    }),
  );

  const repos = deps.repos ? await deps.repos() : await checkoutRepos(config);
  return { repos, providers };
}

/** §20.9 — v1 is one checkout per daemon, asked of git rather than configured twice. */
async function checkoutRepos(config: Config): Promise<string[]> {
  const name = await originFullName(config.repoPath);
  return name ? [name] : [];
}
