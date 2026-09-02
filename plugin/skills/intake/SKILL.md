---
name: intake
description: Talk an idea or a direction change through to exactly one next step — which open release it belongs in, then a vision amendment, a handoff to /kairoku:plan, or a parked note. Use when someone floats a feature, proposes a change of direction, or asks where an idea should go.
user-invocable: true
argument-hint: "[the idea]"
---

# Intake

Something turned up mid-session that is not the work in front of you. This skill decides where it
goes and does **one** thing about it — no more. Triage, not planning: most runs end with a single
document, some end by handing off to `/kairoku:plan`, and a legitimate number end with a sentence
and no write at all.

Project: the resolved project (see `kairoku-mcp`). `$ARGUMENTS`, if given, is the idea.

## 1. Two questions, not an interview

`/kairoku:plan` owns the interview. Here you need exactly two things, asked one message at a time
and only when the answer is not already obvious from what the user said:

- **What is it, in one sentence** — the outcome, not the implementation.
- **Is this a change of direction, or a thing to build?** A direction change edits what the
  project is for (the Vision, the Roadmap, the Poster). A thing to build fits inside a direction
  that already exists.

Then check it is new: `search_documents(query, project)` on the two or three words that would
have been used if someone had already written it down. Search reaches chat messages and activity
entries as well as documents, which is usually where an idea was floated before anyone filed it.
If it is already captured, say where, and stop — a second copy of an idea is worse than none,
because nothing on the eleven-tool surface can delete one.

## 2. Which release

`get_project(project)` returns the releases with their stages. Present the **open** ones — stage
`idea` through `building` — with their stage, and recommend one, in a line each:

```
v1.1 (planning) — <what it is about>            ← recommended: <why>
v1.2 (idea)     — <what it is about>
```

Prefer an early stage. An idea dropped into a release that is already `building` either widens
its scope or sits in its box unbuilt, and both show up at the ship gate rather than now.

**"None of these fits" is a legal answer**, and it is the answer whenever the idea has nothing to
do with any open release. In that case **propose a new release in words** — "create release
`<name>` in the app, then run me again" — and write nothing. Release creation is deliberately not
on the MCP surface: it is a human judgement about stage, so there is no tool here that makes one
and adding one would be a twelfth tool, which is a plan amendment rather than an edit. Do not
route around that by filing the idea somewhere else "for now"; an unplaced idea in a wrong box is
harder to find than one still in the conversation.

## 3. Exactly one next step

One row of this table fires. Not two, and never a first step "to capture it" followed by the real
one:

| What it is | The one step |
|---|---|
| A change of direction — what the project is for, or what it will do next | File `create_document(project, title: "Amendment — Vision", type: "note", content)`. `Vision` is the usual parent; use `Roadmap` or `Project Poster` when that is what actually changes |
| A thing to build, and worth speccing now | Invoke **`/kairoku:plan`**, scoped to this idea and the chosen release. Stop there — the plan skill runs its own interview and writes the spec |
| A thing to build, but not now | `create_document(project, title, type: "note", content)` into the chosen release box, holding the one-sentence outcome and why it is parked |

**The amendment title is a convention the server routes on**, and it is exact: `Amendment — `,
em dash, one space either side, then the title of a living document in this project as
`list_documents` returns it. A hyphen or a missing space files a note with an odd name and nothing
else. The parent must be a real living document — the create refuses and lists the valid parents
otherwise, so read the title rather than guessing at it. With **two or more releases open**, the
create is refused until the title says which: append `(<version>)` — `Amendment — Roadmap (v2)`.
`kairoku-mcp` carries the rest, including why a named version can aim at a sealed box.

A parked note goes into the **release box you chose**. Never `Unsorted/`: it is `reference` class,
so a document lands there read-only and — as the server currently stands — cannot be moved out
from any surface. It is the app's record of a placement it declined to make, not a destination.
If no release fits, you are in the "none of these fits" case above; leave it unfiled and say so.

## The three things this skill never does

- **Never `upsert_plan`.** Not a stub, not a placeholder, not "just a title so it isn't lost". A
  one-line plan item is a roadmap row wearing a story's clothes: it arrives at the implementer
  with no context, no acceptance criteria and no test notes, and it is indistinguishable from
  real work on the Plan tab. Plan items are minted by the `/kairoku:plan` path, which writes the
  six-section body and the test notes at plan time, or they are not minted.
- **Never write to Jira, and never say a ticket was filed.** The app's Sync tab is the only writer
  that records `sync_mappings`; an issue minted anywhere else is invisible to the app forever.
  Everything this skill does ends inside Kairoku, and the human pushes later.
- **Never create a release**, or imply one was created. Propose it in words.

## Finish with what happened

One or two lines: what was filed, where it landed, and the single thing the human does next —
apply the amendment, run `/kairoku:plan`, or nothing at all. If the answer was "already captured"
or "no release fits", say that plainly. A skill that files something on every run is a skill that
manufactures documents.

If the Kairoku server is signed out or absent, say so once with the sign-in command (`/mcp` →
**kairoku** → **Authenticate**) and give the user the text you would have filed, along with which
of the three steps it belongs in. Do not guess at a release you cannot read.
