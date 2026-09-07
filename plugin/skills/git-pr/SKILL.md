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

### Which forge — read the remote, never a flag

The `gh pr create` above is the GitHub path. Some Kairoku repos live on GitLab, where the same thing is
a **merge request**. Decide from the origin remote's host, never from a flag and never by asking:

```sh
remote=$(git remote get-url origin)
hostpath=${remote#*://}      # https:// and ssh:// lose their scheme; git@host:path is untouched
authority=${hostpath%%/*}    # everything before the first path separator
host=${authority##*@}        # drop any user@ prefix
host=${host%%:*}             # drop a port, or the scp-form's :path
```

Both spellings git writes must land on the same answer — `https://gitlab.com/owds-inc/kairoku/kairokud.git`
and `git@gitlab.com:owds-inc/kairoku/kairokud.git` — and a nested GitLab group is part of the path, not
the host. Match the host exactly: a GitHub repo named `gitlab.com-mirror` is not GitLab.

When the host is `gitlab.com`:

```sh
cat > /tmp/mr-body.md <<'EOF'
<the same body as above, unchanged>
EOF
glab mr create --target-branch "$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')" \
  --title "<title>" --description "$(cat /tmp/mr-body.md)"
```

Three things that are not optional:

- **Never a Draft.** No `--draft`, and no `Draft:` or `WIP:` prefix on the title — GitLab reads either as
  draft state, and a draft MR is not the handoff this skill describes.
- **The body is the same one**, from the epic and its stories: the heading, the stories table, Verification,
  the **unticked** manual-test checkboxes, the Preview line. One template serves both forges.
- **The body goes through a file written by a quoted heredoc**, never inline. In a shell a backtick inside a
  double-quoted argument is command substitution, so an inline description silently eats every backticked
  identifier in the body — and has spliced a command's output into a message here before.

`glab mr create` and `glab mr update` take `--description` (short `-d`). There is no `--description-file`;
reach for it and the command fails.

After the PR is open: comment the URL on the epic and on each story, and transition the stories
to *In Review* (see `jira-ops`).

## What not to do

- Never push to the default branch directly.
- Never merge your own epic PR. Opening it is the handoff; merging is the human's.
- Never `--force` a shared branch. Force-push only your own unmerged story branch, and only to
  fix your own last commit.
- Never commit with failing, skipped, or missing tests — the check command must be clean first.
- Never commit secrets, `.env` files, or generated artefacts the repo ignores.
