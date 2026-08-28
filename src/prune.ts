/**
 * `hikyaku prune` — the ONLY thing that removes stale run worktrees.
 *
 * A daemon that died leaves its worktrees behind on purpose: the runner never
 * sweeps automatically (SPEC §Worktree module). This CLI enumerates, prints,
 * asks, and only then removes. It is run by a human.
 *
 * Branches are never deleted — the run's commits are the deliverable.
 */

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const stale = await listRunWorktrees(config.repoPath);
  console.log(formatPlan(stale));
  if (stale.length === 0) return 0;

  if (!argv.includes("--yes")) {
    const answer = prompt("Remove these worktrees? [y/N]") ?? "";
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
  console.log(`${removed}/${stale.length} removed.`);
  return removed === stale.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
