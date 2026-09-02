---
name: plan
description: Take an idea from rough intent to a pushable plan inside the Kairoku app — a short one-question-at-a-time interview, a spec document, then phases and items written with upsert_plan. Use when the user wants to spec, design, or break down work — "write a spec", "plan this", "how do we build this". Agents never create Jira issues for plan structure; the human pushes the plan out of the app.
user-invocable: true
argument-hint: "[topic or release]"
---

# Plan

Turn intent into a spec and a plan that an implementer — human or agent — can execute without
asking questions. Both live in the **Kairoku app**, written over MCP per `kairoku-mcp`. The
repo never holds design docs, and nothing this skill produces is ever committed to git.

Project: the resolved project (see `kairoku-mcp`). `$ARGUMENTS`, if given, names the topic or release.

## The one rule that keeps the Plan tab alive

**Never create Jira issues for plan structure.** Not one, not "just this epic". The app's push
is the only writer that records `sync_mappings`; an issue minted anywhere else has no mapping,
the app's status refresh never sees it, and the Plan tab goes quiet with nobody knowing why.
Write the plan with `upsert_plan` and tell the human to push it from the app (Sync tab).

## Spec first

1. **Absorb what exists.** `get_project`, then `list_documents` and `search_documents` for
   prior specs, research, and the PRD — search reaches chat messages and activity entries as
   well as documents, which is usually where a decision was made before anyone wrote it down.
   Read `Direction/`'s Vision and Roadmap first — they are where the project has already
   settled what it is for and what comes next, and an interview that ignores them asks the
   user to restate their own decisions back to you.
   Read the repo freely for constraints. Come to the interview already knowing what's knowable.
2. **Interview — one question at a time.** One question per message, multiple-choice where
   possible (use AskUserQuestion when available). Cover the problem, what success looks like,
   constraints, scope edges, and non-goals. Challenge anything that doesn't serve the stated
   problem. If the user is away or questions go unanswered, don't stall: make the most
   reasonable assumption, record it in a visible **Assumptions** section, and continue.
3. **Write the spec into Kairoku.** `list_documents(project, type: "spec")` first — the app
   pulls Confluence in, so the document often already exists; `update_document` on the id you
   find, `create_document(project, title, type: "spec", content)` only when it truly doesn't.
   A duplicate is permanent until a human removes it in the UI.
4. **Self-review before showing it.** Hunt for placeholder text ("TBD", "appropriate
   handling", "etc."), contradictions between sections, and scope that crept past the goals.
   The user reviews a clean document, then approves or edits.

Small change to something already specced? Skip the ceremony: update the existing spec
document and go straight to the part of the plan that changes.

## Where the documents go: the release box's slots

Every release owns a box — `Releases/<version>/` — seeded from the project template with a fixed
set of slots. **File into a slot; never invent a folder.** A folder you make up is outside the
template, so the seeder, the stage preflight and the create-routing are all blind to it, and a
document parked there satisfies nothing.

These are the box's slots, named exactly as the template names them:

| Slot | Class | What it holds | Gate |
| --- | --- | --- | --- |
| `Release Brief` | working | the release in a page — problem, shape, what "done" looks like | warns from `idea` |
| `PRD` | working | the product requirements; seeded titled `PRD — <version>` | warns from `planning` |
| `Specs/` | working | one spec document per spec — the folder is present once it holds one real document | warns from `planning` |
| `Implementation Plan` | working | the plan narrative that accompanies the phases and items | warns from `handoff` |
| `Design/` | working | design prompt, architecture and flow diagrams | never required |
| `Research/` | reference | this release's research — reference class: superseded with a new document, never edited | never required |
| `Agent Briefs/` | working | agent prompts written for this release | never required |
| `Amendments/` | working | `Amendment — <parent>` documents against living parents | never required, but a pending one blocks the ship |
| `Release Checklist` | working | what has to be true before it ships | warns from `handoff` |
| `Release Notes` | working | what shipped, for the people who did not build it | **blocks** at `shipped` |
| `Retrospective` | working | what to keep and what to change | **blocks** at `shipped` |

Two things a plan writer should read off that table. A `warn` never stops a stage change — only
`Release Notes` and `Retrospective` are hard gates, and they are hard at ship, so an empty one is a
plan problem long before it is a release problem. And a slot's seeded stub ("> `<title>` — seeded by
the project template.") reads as *missing*, not present: a slot is satisfied by content, not by
existing.

The project-scoped folders — `Direction/`, `Records/`, `Operations/`, `Reference/` — are not part of
any box. They are seeded once per project and hold the living and ledger documents a release amends
rather than edits.

## Then the plan

Phases in dependency order, each with a one-line goal. Items inside each phase, where every
item passes the **three-part scope test**:

1. Can it be verified independently?
2. Does it touch one concern only?
3. Would it get its own commit?

An item that fails any part is either two items or half of one. Right-size for one sitting,
one commit — forty micro-steps are as unexecutable as three boulders.

**No placeholders, anywhere.** Forbidden: "TBD", "add appropriate error handling", "similar
to item N", or any step that says *what* without *how*. If you can't write it concretely, the
spec has a hole — go resolve it, don't paper over it. This applies doubly to `testNotes`:
they are written **now**, at planning time, for every item — expected behaviour and edge
cases before any implementation exists. That is the TDD contract the implementer builds from,
and per `jira-ops` a placeholder there blocks the story outright.

### The shape of an item

An item's `description` is the whole brief the implementer gets — it cannot walk over and ask.
It reads that brief in a fixed order, so write it in that order:

1. **Context** — why this exists, what it depends on, what has already been settled.
2. **Objective** — the observable outcome.
3. **Implementation notes** — where the code goes and what it should look like.
4. **Acceptance criteria** — what makes it done.
5. **Out of scope** — the boundary, which binds as hard as the objective.
6. **Definition of done**.

Context opens with a `Satisfies:` line naming the requirement ids this item implements,
comma-separated:

```text
Satisfies: FR-003, FR-004, SC-002.
```

An item that satisfies no stated requirement is one of two things: scope creep, or evidence
that the spec is missing a requirement. Both are worth stopping for and neither is worth
writing around, so write the line before the item rather than after it. A phase body carries
the mirror line — `Verifies: FR-003, FR-004` — naming what that phase's flow test exercises.
Nothing gates on `Verifies:`; it exists so a phase's purpose can be read without opening every
item beneath it.

**Test notes never go in the body.** They go in the item's own `testNotes` field, every time,
because that field is what becomes the body of the item's `Automated tests` subtask in Jira.
Notes written into the description instead leave that subtask holding a placeholder that tells
the implementer to go define tests which already exist a few lines above it — and per
`jira-ops` a placeholder there blocks the story outright.

**Requirement ids are append-only.** `FR-###` for functional requirements, `SC-###` for
success criteria, allocated in order, never renumbered and never reused. Deleting a
requirement leaves a gap in the sequence, and the gap is correct: an id frozen into a pushed
Jira story cannot be re-pointed afterwards, so a renumber silently re-aims every story that
cites the old number at somebody else's requirement.

**Self-review the plan in both directions.** Every requirement id in the spec is named by at
least one item's `Satisfies:` line, and every id an item names is defined in the spec. A
requirement nothing satisfies is unbuilt work; an id nothing defines is a typo, or a
requirement someone deleted without noticing who was pointing at it.

A UI item adds `plugin/skills/plan/ui-story-template.md`'s **Visual target** block to its Context and
its side-by-side criterion to its Acceptance criteria. That template is an addendum to this
shape, not a competing one.

Write it with `upsert_plan(project, release, phases[], base_updated_at)` — a phase is
`{name, description?, items?}`, an item `{title, description?, testNotes?}`. Both are matched by
name, and neither write overwrites an item's status or its Jira key, so re-running after an edit
is safe.

Two things about that re-run, and both fail quietly. **Read the release with `get_plan` first and
pass its `updatedAt` back as `base_updated_at`**, passing the SAME `release` you are about to
write — read the current release and write a different one and you are compared against the wrong
marker, refused, and looping. On a mismatch nothing at all is written, so re-read and re-apply.
Every plan write advances that marker, so a read is good for exactly one write. Know what it does
not cover, though: adding, renaming, reordering or deleting a phase or item in the app's UI does
NOT advance it, so a matching marker is not proof nobody has edited the plan — it guards you
against a competing plan write, not against a person working in the app. **And send the whole plan, not just the phases you changed**: order
comes from the position in your payload, so a call carrying a subset renumbers it over the rows
you left out. Send every phase, and every item of every phase you touch, in the order you want
them — omitting `description` or `testNotes` preserves what is stored, so an untouched item
costs only its title. `kairoku-mcp` carries the rest, including why inserting into the middle
of a plan takes two writes.

## Hand the push to the human

There is no push tool, by design. Finish by saying exactly what to click: which release to
push from the app's Sync tab, and what it will create. **Check before you say it** —
`get_plan(project, release)` — it also takes `include_ledger` if you want what agents have
recorded — and look at two things. Existing Jira keys: an item that already
has one is duplicated by a second push, not linked. And empty descriptions: one item with no body
refuses the entire release before the push reaches Jira at all, and the app names the items to
fix. A missing `Satisfies:` line or absent `testNotes` only warns and still pushes, which is
the worse outcome — nothing is stopped, and the story arrives short of the brief it was meant
to be.

Then stop. Planning ends at the push instruction; implementing is the implementer's job.
