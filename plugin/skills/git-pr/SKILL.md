---
name: git-pr
description: Branch, commit, merge and pull-request conventions for Kairoku delivery — one branch per story, an integration branch per epic, issue-key-first commits, wave merges, and PR bodies built from the epic's own stories. Background knowledge for agents; not a user command.
user-invocable: false
---

# Git and PR conventions

These are not invented — they are the conventions the repository already runs on. Match them
exactly so history stays greppable and Jira's GitHub integration keeps linking.

## Branches

| Kind | Shape | Example |
|---|---|---|
| Story | `story/<KEY>-<slug>` | `story/KAIR-185-ownership-adoption` |
| Epic integration | `mvp/<EPIC-KEY>` | `mvp/KAIR-179` |
| Defect | `fix/<KEY>-<slug>` | `fix/KAIR-224-share-publish` |
| Housekeeping | `chore/<slug>` | `chore/sprint11-barrier-sweep` |

The slug is two-to-four words from the story title, lowercase, hyphenated. Not the whole title.

Stories branch **from the epic's integration branch**, not from the default branch (read it,
don't assume: `git symbolic-ref --short refs/remotes/origin/HEAD`, strip the `origin/`) — that
is what makes a wave merge trivial and keeps the epic's PR reviewable as one change.

## Commits

```
KAIR-185 Move every tenancy join onto the one ownership helper
```

Issue key first, then a sentence-case imperative. The key must lead so Jira's GitHub
integration picks it up; without it the story shows no development panel and the trail is lost.

Body only when the change needs a why. Say what the change makes true, not what you did.

Commit per coherent step, not per file and not once per story — a story of any size usually
lands in two to five commits that each make sense alone.

## Wave merges

When a wave's stories are done, merge each into the epic's integration branch:

```
Merge story/KAIR-185-ownership-adoption into mvp/KAIR-179 (Sprint 11 Wave 5)
```

The trailing `(Sprint N Wave M)` is what lets you reconstruct which stories ran together
months later. Keep it.

Merge order within a wave does not matter — the stories are independent by construction. If
two conflict, that is a dependency the scout missed: resolve it, and say so in the wave report
so the next epic's graph gets it right.

**After every wave, run the full suite on the merged state**, not just the stories' own tests.
Wave-level breakage is exactly what per-story green misses.

## Pull requests

**One PR per epic** by default: integration branch → the default branch. Per-story
PRs are available when a story needs isolated review, but the default is one, because the epic
is the unit a human actually reviews.

Open it with `gh pr create`. Build the body from the epic and its stories — never a generic
template:

```markdown
## <EPIC-KEY> — <epic name>

<One paragraph: what this epic makes true, from the epic's own Objective.>

### Stories

| Story | What changed | Tests |
|---|---|---|
| [KAIR-185](url) | <one line> | <N passed> |

### Verification
- `<check command>` clean on the merged branch
- Flow test — <phase>: <result>

### Manual test (human)
- [ ] <one line per Manual test subtask, distilled to a step>

Preview: <URL once the deploy lands>
```

The manual-test checkboxes go in **unticked, always**. They are the human's gate; an agent that
pre-ticks them has removed the only check on its own work.

After the PR is open: comment the URL on the epic and on each story, and transition the stories
to *In Review* (see `jira-ops`).

## What not to do

- Never push to the default branch directly.
- Never merge your own epic PR. Opening it is the handoff; merging is the human's.
- Never `--force` a shared branch. Force-push only your own unmerged story branch, and only to
  fix your own last commit.
- Never commit with failing, skipped, or missing tests — the check command must be clean first.
- Never commit secrets, `.env` files, or generated artefacts the repo ignores.
