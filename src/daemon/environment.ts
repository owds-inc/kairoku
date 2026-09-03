/**
 * §20.11 — one run's environment, prepared and torn down.
 *
 * This is the wiring between the three pieces below it: `manifest.ts` says what
 * the repo needs, `env.ts` produces the values, `compose.ts` produces the ports
 * and the services. Everything a member of a team is given passes through here,
 * once, and comes back as one `values` map plus one `teardown()`.
 *
 * TEARDOWN IS RETURNED EVEN WHEN PREPARATION FAILED, and that is the contract
 * the caller depends on: it registers `teardown` FIRST and checks `ok` second,
 * so a compose project that came up before the init step failed is not left
 * running on a machine nobody is watching. It is idempotent, because cancel,
 * timeout, a normal exit and daemon shutdown can all reach it, and it never
 * throws — an exit path that can fail is an exit path that leaks containers.
 *
 * NO MANIFEST → TODAY'S BEHAVIOUR: no ports, no compose, no init, and the four
 * per-run values every run has always had.
 */

import {
  allocatePorts,
  composeDown,
  composeUp,
  projectName,
  releasePorts,
  type ComposeDeps,
  type PortDeps,
  type PortRange,
} from "./compose";
import { envStorePath, mergeEnv, readCheckoutEnv, readEnvStore, substitute } from "./env";
import { profileOf, type Manifest } from "./manifest";
import { childEnv } from "./runs";
import { run as execArgv, type CommandResult } from "./worktree";

export interface EnvironmentSpec {
  readonly dispatchId: string;
  readonly runId: string;
  /** The member's worktree — the cwd of compose, of init, and of the agent. */
  readonly worktree: string;
  /** `owner/name` of the checkout, which keys the env store. */
  readonly repoFullName?: string;
  readonly profileName: string;
  readonly manifest?: Manifest;
  /** Layer 3, already resolved on this machine. Memory only. */
  readonly secrets: Record<string, string>;
  /** The run's own values — its credential and its ids. */
  readonly perRun: Record<string, string>;
  readonly portRange: PortRange;
  /** Where the daemon's env store lives — `~/.kairoku/env` on a real daemon. */
  readonly envDir?: string;
}

export interface EnvironmentDeps {
  readonly ports?: PortDeps;
  readonly compose?: ComposeDeps;
  /** How an `init[]` command is run. Same shape as `worktree.run`. */
  readonly exec?: (argv: string[], cwd: string, env?: Record<string, string>) => Promise<CommandResult>;
}

export interface PreparedEnvironment {
  readonly ok: boolean;
  /** Why it failed. Absent when it did not. */
  readonly summary?: string;
  /** The merged values, low → high. Handed to every role and to the QA step. */
  readonly values: Record<string, string>;
  readonly ports: Record<string, number>;
  readonly project?: string;
  /** Idempotent, never throws. Registered by the caller before `ok` is read. */
  teardown(): Promise<void>;
}

export async function prepareEnvironment(
  spec: EnvironmentSpec,
  deps: EnvironmentDeps = {},
): Promise<PreparedEnvironment> {
  const exec = deps.exec ?? execArgv;
  const profile = spec.manifest ? profileOf(spec.manifest, spec.profileName) : undefined;

  // A manifest that declares profiles but not THIS one is a mismatch between
  // what the app offered and what the repo has. Guessing another profile would
  // run the work against whatever environment happened to be listed first.
  if (spec.manifest && !profile && Object.keys(spec.manifest.env).length > 0) {
    return settled({
      ok: false,
      summary: `kairoku.json declares no "${spec.profileName}" profile (it has: ${Object.keys(spec.manifest.env).join(", ")})`,
      values: {},
      ports: {},
    });
  }

  let ports: Record<string, number> = {};
  try {
    ports = allocatePorts(profile?.ports ?? [], spec.portRange, deps.ports);
  } catch (err) {
    return settled({ ok: false, summary: message(err), values: {}, ports: {} });
  }

  const portValues = Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, String(port)]));
  const injected = Object.fromEntries(
    Object.entries(profile?.inject ?? {}).map(([key, template]) => [key, substitute(template, ports)]),
  );

  const values = mergeEnv({
    checkout: readCheckoutEnv(spec.worktree, profile?.files ?? []),
    store:
      spec.repoFullName && spec.envDir
        ? readEnvStore(envStorePath(spec.envDir, spec.repoFullName, spec.profileName))
        : {},
    secrets: spec.secrets,
    // The ports come first so `inject` can be read against them, and the run's
    // own ids and credential come LAST: a manifest that named `KAIROKU_PAT` in
    // its `inject` would otherwise hand the agent a credential of the repo's
    // choosing.
    perRun: {
      ...portValues,
      ...injected,
      KAIROKU_RUN_ID: spec.runId,
      KAIROKU_DISPATCH_ID: spec.dispatchId,
      ...spec.perRun,
    },
  });

  const project = profile?.compose ? projectName(spec.runId) : undefined;
  // Compose and init need a working PATH, HOME and DOCKER_HOST as well as the
  // run's values; `childEnv` is the same one-way merge the agents get, with the
  // daemon's own credentials stripped.
  const shellEnv = childEnv(values);

  const done = { ok: true, summary: undefined as string | undefined, values, ports, project };
  let torn = false;
  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    try {
      if (project) {
        await composeDown(
          { project, ...(profile?.compose ? { file: profile.compose } : {}), cwd: spec.worktree, env: shellEnv },
          deps.compose,
        );
      }
    } catch {
      // A teardown that throws is a run that never reports. The containers are
      // then `kairoku daemon prune`'s, which is exactly what it is for.
    } finally {
      releasePorts(ports);
    }
  };

  const fail = (summary: string): PreparedEnvironment => ({ ...done, ok: false, summary, teardown });

  if (project && profile?.compose) {
    const up = await composeUp({ project, file: profile.compose, cwd: spec.worktree, env: shellEnv }, deps.compose);
    if (!up.ok) return fail(up.summary);
  }

  for (const command of profile?.init ?? []) {
    const result = await exec(["sh", "-c", command], spec.worktree, shellEnv).catch((err: unknown) => ({
      code: 127,
      stdout: "",
      stderr: message(err),
    }));
    if (result.code !== 0) {
      return fail(
        `the environment's init step failed: \`${command}\` exited ${result.code}\n${tail(result)}`,
      );
    }
  }

  return { ...done, teardown };
}

/** A prepared environment that never got as far as holding anything. */
function settled(base: Omit<PreparedEnvironment, "teardown">): PreparedEnvironment {
  return { ...base, teardown: async () => {} };
}

function tail(result: CommandResult, lines = 40): string {
  return `${result.stdout}${result.stderr}`.trim().split("\n").slice(-lines).join("\n").slice(0, 2000);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
