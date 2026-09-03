/**
 * `kairoku daemon prune` — the ONLY thing that removes what a dead daemon left
 * behind: stale run worktrees, and (O-4) the per-run compose projects that came
 * up with them.
 *
 * The daemon never sweeps automatically (SPEC §Worktree module). This CLI
 * enumerates, prints, asks, and only then removes. It is run by a human.
 *
 * Branches are never deleted — the run's commits are the deliverable. Only
 * `kairoku-<something>` projects are offered: the bare `kairoku` project is what
 * `docker compose up` in the app checkout creates, and taking that down would
 * stop the machine owner's own database.
 */

import { composeDown, composeProjects, type ComposeDeps } from "./compose";
import { loadConfig } from "./config";
import {
  gitWorktreeOps,
  listRunWorktrees,
  type StaleWorktree,
} from "./worktree";

export function formatPlan(stale: StaleWorktree[]): string {
  if (stale.length === 0) return "No run worktrees found. Nothing to prune.";
  const lines = stale.map((w) => `  ${w.branch}\t${w.path}`);
  return [
    `${stale.length} run worktree(s) to remove (branches are kept):`,
    ...lines,
  ].join("\n");
}

export function formatProjects(projects: string[]): string {
  if (projects.length === 0) return "No per-run compose projects found.";
  return [
    `${projects.length} orphaned compose project(s) to remove (with their volumes):`,
    ...projects.map((name) => `  ${name}`),
  ].join("\n");
}

export interface PruneDeps {
  readonly compose?: ComposeDeps;
}

export async function main(argv: string[] = process.argv.slice(2), deps: PruneDeps = {}): Promise<number> {
  const config = loadConfig();
  const stale = await listRunWorktrees(config.repoPath);
  // A machine with no docker answers with an empty list, so the worktree half
  // still works on a laptop that only ever carried the plugin.
  const projects = await composeProjects(deps.compose);
  console.log(formatPlan(stale));
  console.log(formatProjects(projects));
  if (stale.length === 0 && projects.length === 0) return 0;

  if (!argv.includes("--yes")) {
    const answer = prompt("Remove these? [y/N]") ?? "";
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted. Nothing removed.");
      return 1;
    }
  }

  const ops = gitWorktreeOps(config.repoPath, config.worktreesDir);
  let removed = 0;
  for (const worktree of stale) {
    try {
      await ops.remove(worktree);
      console.log(`removed ${worktree.path}`);
      removed++;
    } catch (err) {
      console.error(
        `FAILED ${worktree.path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let down = 0;
  for (const project of projects) {
    // No `-f`: the compose file lived in a worktree that is gone by now, and
    // Compose finds a project it started from its own container labels.
    const result = await composeDown({ project, cwd: config.repoPath, env: {} }, deps.compose);
    if (result.ok) {
      console.log(`removed ${project}`);
      down++;
    } else {
      console.error(`FAILED ${project}: ${result.summary}`);
    }
  }

  if (stale.length) console.log(`${removed}/${stale.length} removed.`);
  if (projects.length) console.log(`${down}/${projects.length} compose project(s) removed.`);
  return removed === stale.length && down === projects.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
