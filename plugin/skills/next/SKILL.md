---
name: next
description: Where the project stands and the single thing to do now, answered from the Kairoku app's live plan and release gates. Use when the user asks "what now", "what should I do next", "where are we", or comes back to a project after time away.
user-invocable: true
argument-hint: "[project]"
---

# What to run next

One question, one answer: **what is the next thing to do, and what do I type to do it.**
Not a status report, not a backlog, not a menu.

## Read the gates, not the backlog

Fastest path first, and stop as soon as you can answer:

1. **Kairoku**: `get_project` for the resolved project (see `kairoku-mcp`) with `brief: true` —
   one call for what moved since last time, what is blocked, the current phase's remainder, the
   release's next gate, and the Jira picture. Replaces separately calling `get_project` and
   `get_plan` and re-deriving all of that by hand; reach for `get_plan` directly only if you need
   a plan item's Jira key or test notes, which the brief does not carry.
2. **The active sprint** — `kairoku-jira sprint current`, then `sprint issues`. KEPT: this is LIVE
   sprint state (what is actually in flight in Jira right now), which nothing in the brief above
   carries — its `jira` field is the last-synced rollup, not the sprint board. Exit 2 means
   unconfigured; fall back to JQL on the project key read from the plan's `jiraIssueKey`
   prefixes (see `jira-ops`) and carry on.
3. **Open PRs** — `gh pr list`. An epic PR sitting unmerged is usually the real answer.

Do not read every document. You are answering one question, not writing a report.

## Decide the one thing

Walk the loop in order and stop at the first gate actually waiting:

| What you find | The answer |
|---|---|
| No spec, or a spec with no plan | `/kairoku:plan` |
| A plan in Kairoku, items without Jira keys | the human pushes it from the app (Sync tab) |
| Stories in Jira, none in progress | start the next unblocked story — name it, and the implementer agent that builds it |
| Items `blocked`, or Test notes still placeholders | name them; they need unblocking or defining before anything runs |
| A story branch with work uncommitted or unpushed | finish it: tests green, the repo's own check gate clean (read package.json scripts — here `bun run lint && bun run build`), PR |
| A PR open, tests green | review and merge it — link it |
| A preview deployed, manual tests unticked | **the human verifies it** — give the URL and the checklist |
| Everything green | promote the release in the app |

## Answer in this shape

```
<Project> <release> — <stage>. <One line on where it actually is.>

Next: <the single action>
  <the exact command, or the exact link>

Also waiting: <at most one, only if genuinely parallel>
```

**Under 100 words, total.** If two things are independent, name the critical path rather than
listing both as equals. When the next action is the human's — verifying a preview, pushing a
plan, merging a PR — say so plainly and give the link. That is a real answer, not a failure to
find one; the manual gate is the point. If nothing is waiting, say the project is idle and
offer the smallest useful step. Do not manufacture urgency.

`$ARGUMENTS`, if given, scopes this to one project.
