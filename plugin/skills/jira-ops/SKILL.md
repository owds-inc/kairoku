---
name: jira-ops
description: The Jira lifecycle protocol every Kairoku agent follows — how to discover transitions rather than hardcode them, who moves which issue when, how to close testing subtasks with evidence, how to comment, and how to block a story without stalling its epic. Background knowledge for agents; not a user command.
user-invocable: false
---

# Jira operations protocol

Every agent that touches Jira follows this. It exists because the failure mode is not "the API
call errored" — it is a board that quietly stops describing reality, which is worse than no
board at all.

The Jira project key is not configured — it is read from the app's own data, because it varies
per user and per project: take any `jiraIssueKey` from `get_plan` on the resolved project (see
`kairoku-mcp`) and use its prefix (`KAIR-123` → `KAIR`). If the plan has no synced issues yet,
ask the human once. Never create or transition anything outside that project.

**Agents never create Jira issues for plan structure.** Epics, stories, and their subtasks are
created by the Kairoku app's push — write the plan with `upsert_plan` and let the human push it
(see `kairoku-mcp`). Agents move issues and comment on them; they do not mint them.

## Finding the tools

Jira reaches you over MCP. The server name varies by install — look for tools matching
`*atlassian*` or `*jira*` (commonly `mcp__plugin_atlassian_atlassian__*`). Resolve `cloudId`
once with `getAccessibleAtlassianResources` and reuse it; do not call it per issue.

Board, sprint, and ranking operations are **not** on the MCP server — they are Agile API only.
Use `kairoku-jira` for those (this plugin ships it at
`${CLAUDE_PLUGIN_ROOT}/bin/kairoku-jira`). It is an optional extra, deliberately not plugin
config — the app already holds the user's Atlassian credentials and the plugin must not keep a
second copy. It activates only when the environment provides `KAIROKU_ATLASSIAN_SITE`,
`KAIROKU_ATLASSIAN_EMAIL`, and `KAIROKU_ATLASSIAN_API_TOKEN`; unconfigured it exits 2 and the
skills that call it fall back. Everything else goes through MCP.

## Never hardcode a transition

Transition ids and names differ per project and per workflow, and they change under you.
Resolve them every time:

1. `getTransitionsForJiraIssue(issueIdOrKey)`.
2. Match on the **target status category** (`To Do` / `In Progress` / `Done`), then on name
   as a tiebreak. Category is stable across workflow renames; names are not.
3. `transitionJiraIssue` with the id you found.

If no transition reaches the state you want, **do not force it and do not fail the story**.
Comment what you wanted, leave the status alone, and report it. A workflow with no
`In Review` state is a normal thing to encounter, not an error.

## Who moves what, and when

| Moment | Who | Action |
|---|---|---|
| Story claimed | implementer | → *In Progress*, assign to itself, one `[agent]` comment naming the branch |
| Tests green, work committed | implementer | close the `Automated tests` subtask with an evidence comment |
| PR opened | implementer | → *In Review*, comment the PR URL on the story |
| Epic PR merged **and** tests green | the human lead | → *Done* |
| Flow test run | whoever ran QA | record the result on the `Flow test` story and the QA Run page |
| Anything at all | any agent | **never touch a `Manual test` subtask** |

Two rules that keep "done" honest:

- **A story is not Done on green tests alone.** Green tests plus a merged PR. Until then it is
  *In Review*, however finished it feels.
- **`Manual test` subtasks and the Manual Test Checklist belong to the human.** No agent closes
  them, ticks them, or transitions them. That is the preview gate, and it is the only thing
  standing between "the agents say it works" and "it works".

## Closing an `Automated tests` subtask

Only on green, and only with evidence a human could check:

```
[agent] Automated tests green.
Ran: <the exact command> → <N passed, 0 failed>
Covers: <the behaviours from the story's Test notes, in a line or two>
Commit: <sha> on <branch>
```

Never close it on skipped tests, on "tests would pass", or after retrying until green — a test
that needed three runs is a flaky test, and a flaky test is a defect. File it as one.

## Comment protocol

One structured comment per state change, prefixed `[agent]` so the human can filter agent
chatter from their own. Not one per commit, not a running log. The story's history should read
as a handful of meaningful events, not a transcript.

## When a story cannot be done

Blocking is a normal outcome, not a failure. Do all three:

1. Comment: what blocked it, precisely what is needed to unblock, and who or what can supply it.
2. Transition to a blocked state if the workflow has one; otherwise leave the status and say so.
3. Return it in your report as blocked, and **carry on with whatever else you were given**. One
   unimplementable story must never stall its epic.

Placeholder `Test notes` are a block, not an invitation to improvise. "Define tests before
implementing" is the whole point of the scaffold; a story that skips it has no definition of done.

Spec contradictions are a block too — the spec lives in the Kairoku app, so record the
contradiction there (`add_progress_note`, and the story's plan item → `blocked`; see
`kairoku-mcp`) rather than adapting silently.

## Sprint field

Do not assume `customfield_10020`. Resolve it with `getJiraIssueTypeMetaWithFields` for the
project's Story type and match on the field named `Sprint`. Moving issues between sprints is no
longer an agent action — the CLI's own way of doing it retired (KAIR-396); the app's Sync tab
assigns issues to sprints now.

## Reading before writing

Before transitioning anything, read the issue. An agent that transitions a story someone
already moved, or reopens something a human closed, destroys the board's credibility faster
than it builds it. If the current status contradicts what you expected, stop and report.
