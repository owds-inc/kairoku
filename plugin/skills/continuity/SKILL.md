---
name: continuity
description: Hand this session's working state to the one that replaces it — persist branch, full commit SHAs, the test command with its counts, in-flight plan item ids and open decisions as one document in Kairoku, then print the short prompt to paste into the fresh session. Use mid-session when context is running low, before a compaction, or when handing work to another agent.
user-invocable: true
argument-hint: "[anything the next session must know]"
---

# Continuity

The session is not over — it is running out of room. This skill writes down everything the
*next* session needs to keep going and hands the user a prompt short enough to paste.

**This is not `/kairoku:wrap`.** Wrap closes a session that finished: one `add_progress_note`,
item statuses, the amendments sweep. Continuity transfers state across a compaction and writes
**no progress note and no item status** — a note saying "still working" is exactly the noise the
activity log is meant not to carry. One moment, one skill. If the work is actually done, stop
here and run `/kairoku:wrap` instead.

Project and release: the resolved project (see `kairoku-mcp`), and the release the work belongs
to — `get_project` names the open ones. `$ARGUMENTS`, if given, is anything the user wants the
next session to know that you would not have written down.

## 1. Collect the state

Everything here is a fact you can read, not a recollection. Gather it before you write anything:

| Field | Where it comes from | What makes it wrong |
|---|---|---|
| Branch | `git branch --show-current` | naming the story instead of the ref |
| Commits | `git log` — **full** object names | abbreviations; the next session cannot check one in a single command |
| Working tree | `git status --porcelain` — uncommitted paths, or "clean" | "some changes outstanding" |
| Test command + result | the command as typed, then **`N passed / N failed / N skipped`** | see below |
| In-flight items | `get_plan` — item **ids**, exactly as returned, never titles | titles get edited and stop resolving |
| Open decisions | this session — what was asked and not settled | omitting them, so the next session re-decides differently |
| Next action | one line: the single thing to do first | a list |

**Never record a test run as "green".** The three counts go in, `skipped` included, or the line
does not go in at all. A run that silently skipped a third of its assertions is green and looks
identical to one that passed, and a resuming session that reads "tests green" builds on top of a
result nobody can falsify. Same reasoning as the ledger entry's `tests` object in `kairoku-mcp`:
`skipped` is the field that separates the two. If you did not run the tests this session, write
that — "not run since <full SHA>" is a fact; "green" is not.

## 2. Write it to ONE document per release

The document is titled exactly **`Continuity — <release>`** and its type is `agent_prompt`, which
routes it into that release box's `Agent Briefs/` — working class, so it stays revisable.

**List, then update.** `create_document` has no dedupe and nothing on the eleven-tool surface can
delete, so a create-per-run leaves a fan of near-identical documents that only a human can clear
out, and the resuming session has to guess which one is current.

1. `list_documents(project)` — look for the title `Continuity — <release>`.
2. Found: `update_document(document_id, content)`. The document is a snapshot of *now*, not a
   ledger — replace the body, do not append a fresh section each run.
3. Not found: `create_document(project, title, type: "agent_prompt", content)`.

Write the body under the same headings as the table above, so the next session can find a field
without reading prose. Keep it to what a resumer needs to act: this is a handover, not a diary of
the session that produced it.

## 3. Print the resume prompt

Five lines, give or take. It is going to be pasted into a cold session, so it names the project,
names the document, and puts the `get_document` call first — one call and the new session knows
everything this one did.

```
Continuing <project-slug>, release <version>, branch <branch>.
First: get_document("<document id>") — that is the full handover.
Then: <the single next action>.
Full state is in "Continuity — <release>" in the release box's Agent Briefs/.
If this session is actually over rather than continuing, run /kairoku:wrap instead.
```

Give the user the real id, not a placeholder. A prompt that says `<document id>` is a prompt that
makes the next session go hunting through `list_documents` for the thing this step existed to hand
it.

## When Kairoku is signed out

The app is optional (see `kairoku-mcp`). If the server is absent or every call 401s, **print the
full state inline** — the whole table from step 1, in the reply — and name the sign-in command
(`/mcp` → **kairoku** → **Authenticate**) once. The user can paste that text into the next session
directly. Failing the skill because the dashboard is unreachable loses the state the skill exists
to save, which is the one outcome worse than not having a document.
