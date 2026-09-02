---
name: kairoku-mcp
description: How Kairoku agents read from and write back to the Kairoku app over MCP — which of its tools to use for what, how to report progress without spamming the activity log, and which writes belong to the app rather than the agent. Background knowledge for agents; not a user command.
user-invocable: false
---

# Working with the Kairoku app

Kairoku is where the user thinks: ideas, documents, and the plan live there, and the app is
what pushes them out to Jira and Confluence. Agents read that context and report progress back.
They do not keep a second copy of it.

**Resolving the project** (nothing is configured — the app is the source of truth): call
`list_projects` and take the project whose name or slug matches this repository; if the human
named a project this session, that wins; if neither settles it, ask once and reuse the answer
for the rest of the session. The other skills say "the resolved project" to mean this.

## The tools, and what each is for

The server ships exactly eleven tools.

| Tool | Reach for it when |
|---|---|
| `list_projects(stage?)` | Orienting across projects, or finding what has a release in a stage (`idea` … `building` … `shipped`) |
| `get_project(project, brief?)` | One project's overview, releases with progress, and document index — the cheapest way to get oriented. `project` is the slug (preferred) or id. Add `brief` for the session brief in the same call: what moved, what is blocked, the current phase's remainder, the release's next gate, and the Jira picture. `sinceBasis` says what "moved" is measured from — `wrap_note`, the newest note written through `add_progress_note`, when the project has one; `lookback`, a 7-day window, when it has none. So on a project that never had a note — the common first session — an empty `moved` means nothing in seven days, not nothing since your last note. `moved` carries the newest 20 rows at most |
| `list_documents(project, type?)` / `get_document(document_id)` | The document index (ids, titles, types — pinned first), then one document in full |
| `search_documents(query?, project?, include?, release?, doc_class?, folder?, updated_since?, type?)` | Case-insensitive substring search over documents, chat messages and activity entries when you don't know where a thing was written or said; up to 20 matches PER KIND, each with a `kind` and its excerpt in `snippet`. `include` narrows it to a subset of `document` / `message` / `activity`. The other four narrow the DOCUMENT hits and compose freely: `release` (a version like `v1`, or a release id) for one release's box, `doc_class` (`reference` / `living` / `ledger` / `working`), `folder` (a folder's NAME such as `Specs` — a name, not a path), `updated_since` (an ISO timestamp lower bound), `type` (the document's own type — `spec`, `research`, `architecture_diagram`). Reference and living documents rank above ledger and working ones for the same match, so read the top of the list first. **`query` is optional when you pass at least one filter**: "every spec in v1's box", "anything updated since Friday" — a filter-only search returns DOCUMENTS only, because a chat message and an activity row have no folder, class, box or type. Neither a query nor a filter is refused with a sentence naming the filters, not answered with the whole workspace. **A feature is a FOLDER** — `Planning/<Feature>/` while unassigned, the release box once assigned — so `folder` IS the feature filter; there is no `feature` argument |
| `get_plan(project, release?, include_ledger?, include_context_pack?)` | The release's ordered phases and items with their statuses and **Jira keys**. This is how you map a plan item to the issue you are about to work. No `release` means the current one; pass a version like `1.2`, or `all`. Add `include_ledger` to attach the entries agents have recorded against each item — CLAIMS, not verified facts, and the result says how many it read and whether it hit its bound. An entry that fails the version, JSON or shape gate is deliberately attached to no item: it lands raw in the top-level `ledger.unreadable`, so read that array too rather than only each item's — it holds exactly the entries the reader would not guess about. Add `include_context_pack` to ORIENT IN ONE CALL: the release box's documents (a human put them there — the box IS the curation), the last progress note anyone wrote, and a derived per-release summary (stage, progress, current phase, open items). Bodies come back as clipped excerpts with their ids — call `get_document` for anything you need in full — and `documents_omitted` says what the cap left out |
| `update_item_status(item_id, status, note?, expected_status?, expected_title?)` | A plan item genuinely changed state: `not_started` / `in_progress` / `blocked` / `done`. `item_id` comes from `get_plan`. Both success shapes carry `moved`, and `moved: true` is how you know your write landed; the not-found error carries no `moved` at all, so test for `moved === true` rather than for the field's absence. Pass `expected_status` — the status you read the item at — and a writer who got there first makes your write a no-op instead: `moved: false` with the status the item actually holds, or the not-found error if the row disappeared between the attempt and the re-read. Without it the write is unconditional and overwrites whatever it finds. Pass `expected_title` — the title you believe `item_id` names, compared ignoring case and surrounding spaces — and a wrong id becomes `moved: false` carrying the title the item ACTUALLY holds, so you see what you almost moved instead of silently moving it. Pass it whenever the id did not come straight from a `get_plan` in this same conversation |
| `add_progress_note(project, note, human_todo?)` | A milestone worth a line on the activity feed. Add `human_todo` — `{kind: "todo"|"question", title, body?}` — when the note reaches something only a PERSON can settle: it files a durable item that resurfaces on their home page and the project page until they close it, instead of a sentence that scrolls away. `question` means you need an answer back and are stopped without it; `todo` is work for them that does not block you. Use `project: "inbox"` for one that belongs to no project. You file it; only they close it |
| `create_document(project, title, type, content, format?, folder?)` | Filing a NEW document into Kairoku. Types: `spec`, `plan`, `prd`, `research`, `note`, `competitive_analysis`, `design_prompt`, `agent_prompt`, and the diagram kinds (`ui_mockup`, `architecture_diagram`, `flow_diagram`). `format` is `markdown` (default), `html`, or `mermaid`. `folder` is a template-slot slug (`reference-research`) or a `/`-joined path (`Reference/Research`, `Releases/v2/Specs`) to file it into a specific place, wins over the server's own naming-convention routing, and refuses — naming the valid slugs — on an unknown or ambiguous target; omitted, routing behaves exactly as before |
| `update_document(document_id, title?, content?, append?, project?)` | Revising one you (or the Confluence pull) already put there — the correct move whenever the title already exists. Type and format cannot change. For a ledger document (Records/), pass `append` instead of `content` — one new row, tagged with an open release — and the server concatenates it onto the stored body instead of you retransmitting the whole thing; `append` and `content` are mutually exclusive, and `append` refuses on anything that isn't a ledger. `project` (slug or id) moves it to another of your own projects, where it lands unfiled — refused for a document published to Confluence. A capture still waiting in the Inbox refuses every write, move included: promotion out of it is the human's move |
| `upsert_plan(project, release?, phases[], base_updated_at?)` | Writing plan structure: phases with items, each item `{title, description?, testNotes?}`. Idempotent by name; never overwrites an item's status or its Jira key. Pass `base_updated_at` — the release's `updatedAt` from the `get_plan` you wrote this from — to be refused rather than overwrite a competing plan write: on a mismatch NOTHING is written, so re-read and re-apply. It does NOT see structural edits made in the UI (see below) |

`get_project` before `get_plan` before anything else — one call usually answers what three
Jira searches would.

**The optional arguments are typed, and two of the types are not guessable.** `brief` and
`include_ledger` take a real boolean or the strings `"true"` / `"false"`, and nothing else — no
`1`, no `"yes"`. `include` takes a JSON **array** of kind strings, `["document","activity"]`, never
the bare string `"document"`; an empty array is accepted and returns nothing, which reads exactly
like no matches, so omit `include` entirely to search every kind.

**Order is the payload's index, but only for rows that already exist.** `upsert_plan` matches
phases and items by trimmed lowercase title and sets `order` from the position in what you sent —
so sending a subset silently renumbers it to `0..n` and collides with whatever you left out. Send
every phase, and every item of every phase you touch, in the order you want them. Omitting
`description` or `testNotes` preserves what is stored, so the ones you are not editing cost only
their title.

A **new** phase or item is the exception: it appends to the end rather than claiming your payload
index, deliberately, because the index it was given may already belong to an existing row. So
inserting into the middle of a plan cannot be done in one call — the first call creates the row at
the end and reports success, which is the whole problem. Send the payload again: the second call
finds every row existing, takes the update path, and lands each one on its payload index. If you
passed `base_updated_at`, the same marker will not do twice — a plan write advances the release's
revision, and a reused marker is a staleness refusal that writes nothing and leaves the new row
stranded at the end.

**Two reads, and they are for different things.** The read *between* the writes exists only to
supply a fresh `updatedAt` for the second one. Pass it the same `release` argument you are writing:
`get_plan` with no `release` resolves the CURRENT release, while the refusal compares against the
release your write targeted, so an insert into any other release loops forever on the wrong marker
— refused, re-read, refused. Do not check orders off that read. Between the two writes is by
construction the moment orders are duplicated and non-contiguous: the new row is sitting at the end
holding an appended order while everything after its insertion point has already taken its payload
index. Read *again after the second write*, and that is the read that has to show phase orders
unique and item orders contiguous within each phase before you believe the insert worked.

**The marker does not see a human editing the plan, which is the gap that can cost you work.**
Exactly three writers bump `releases.updatedAt`: a release stage change on the board, a release
edit on the Plan tab (version, scope note or target date), and `upsert_plan` itself. **Every
structural edit made in the UI leaves it untouched** — adding, renaming, reordering or deleting a
phase or an item, and editing test notes. So a marker can still match while the plan underneath it
has changed, and your write is then accepted: it renumbers their rows to your payload's indices,
re-creates an item they deleted, and appends a duplicate of one they renamed, because matching is
by trimmed lowercase title. Read `base_updated_at` as protection against a competing *plan write*,
not against a person working in the app. Item status is the other way: `update_item_status` and the
app's Jira status refresh touch no release row, deliberately, so an executor moving items all day
never invalidates your read of the plan's structure. And because the three that do bump it include
a scope-note or target-date edit, a refusal on a first write often just means a human touched the
release — re-read and re-apply, same as any other refusal.

**List before you create.** `create_document` has no dedupe, and no tool on this server can
delete anything. The app pulls the whole Confluence space in, so a document you are about to
create very often already exists under the same title. `list_documents` first, then
`update_document` on the id you find. A duplicate is permanent until a human removes it in the UI.

## The document tree and who writes what

**The folder carries the class, not the document.** Every folder the template seeds holds one of
four classes — `living`, `ledger`, `reference`, `working` — and each is a different answer to "who
may change this, and how". Two things carry none: a document sitting in no folder, and a folder
that came from outside the template (a Confluence page pulled in, an adoption leftover). Both fall
through to rule 5 below and are governed by nothing. That is the state a capture is in before
anyone has placed it, not a loophole to route through.

One guard stands behind all four write seams — the Documents tab, this MCP server, the chat, and
the Confluence pull — so the same write refuses the same way from almost anywhere. One gap is worth
knowing rather than discovering: rule 3 below branches on `agent` and `user` only, and the pull
writes as `system`, so a Confluence-side edit to a living document lands where the identical edit
from here refuses. **The refusal
text is the whole contract**: it names what fired and what to do instead, and there is no side
channel carrying a rule id. Read the message and act on it rather than retrying the same call.

The rules run **in order, first match wins**, and the order is load-bearing:

1. **A frozen box refuses everyone.** Any folder inside a release at stage `shipped` or `parked`
   refuses every write, from every actor, whatever the class — a *create* into a sealed box's
   `Research/` included. Sealing outranks class because the point of sealing is that the record
   of what shipped stops moving.
2. **`reference` allows a create and refuses everything else** — for every actor, human included.
3. **`living` refuses an agent outright**, and refuses a human unless they confirm past the
   editor's amendment-governed banner.
4. **`ledger` is append-only**, checked only when the write actually changes content.
5. **`working`, and unclassified, allow.**

| Class | Where it lives | What an agent may do | What a human may do |
|---|---|---|---|
| `living` | `Direction/` (Project Poster, Vision, Roadmap), `Operations/` (Test Strategy, Runbook), `Reference/Design System/` | Nothing. Every write refuses — update, move, delete, **and create**: rule 3 never reads the operation, so filing a new document straight into `Direction/` refuses exactly like editing the Vision does. File `Amendment — <title>` instead | Confirm past the editor's amendment-governed banner — but on an *update* only. The override is passed by `updateDocument` alone, so a human's create, move or delete against a living folder refuses outright, with no banner to confirm past. The confirmation is the human's; an agent write never carries it |
| `ledger` | `Records/` (Decision Log, Build Journal, Risk Register & Premortem) | Append one new row, tagged with an open release's version. Editing, reordering or deleting an existing row refuses | Exactly the same. Append-only is what the class *is*, not a courtesy extended to agents |
| `reference` | `Reference/Research/`, each release box's `Research/`, and `Unsorted/` | Create a new document. Update, move and delete all refuse — supersede it, never edit it | Exactly the same. Reference material is a record of what was believed at the time, and an edited one answers a question nobody asked |
| `working` | Everything else in a release box: Release Brief, PRD, `Specs/`, Implementation Plan, `Design/`, `Agent Briefs/`, `Amendments/`, Release Checklist, Release Notes, Retrospective | Read and write freely, until the box freezes | Read and write freely, until the box freezes |

Two edges worth knowing before you hit them. A ledger write that changes no content — a rename, a
move between projects — never reaches rule 4 at all, and neither does *creating* a document in
`Records/`: only a change to an existing body is an append that has to be tagged.
`update_document`'s `append` is an ergonomic over that same rule and not an exemption from it: the
server concatenates the row and runs the identical check, and refuses `append` outright on
anything that is not a ledger. And rules 1 through 3 are checked before it, so a ledger inside a
shipped box refuses a perfectly well-formed append.

### Filing an amendment

A living document is refused to you because it is one a human curates. The way through is not a
different call — it is a **proposal a human applies**, and the proposal is an ordinary document:

- **Title it exactly `Amendment — <parent>`** — em dash, one space either side. The prefix is what
  the server's routing reads; a hyphen or a missing space is just a note with an odd name.
- **`<parent>` must be the title of a living document in this project**, or the create refuses and
  lists every valid parent. There is nothing to guess at: take the title from `list_documents`.
- It lands in the target release box's `Amendments/`, which is `working` class — so once filed it
  is yours to revise like anything else in the box.

**Which release box, and the `(vN)` suffix.** With exactly one release open, the server picks it
and the title needs nothing extra. With **two or more open and no version named**, the create is
refused rather than guessed:

```
"Amendment — Runbook" — multiple releases are open (v1, v2); add "(<version>)" to the title to say which one.
```

Append the suffix and it routes: `Amendment — Runbook (v2)`. A named version resolves to that
release **whatever its stage**, which is the one way to aim at a sealed box by accident — rule 1
then refuses the write, and that refusal is about the box rather than the title, so re-reading it
as a naming problem sends you in circles. With no release open at all, the amendment lands unfiled
instead of refusing.

### `Unsorted/`

`Unsorted/` is not a template slot and no slug names it. It is created **lazily, on first need**,
by the two paths that must park something they could not place: the Confluence pull, for a page
that maps to no slot, and the adoption wizard, when a human confirms a row to it. It is
`reference` class, so everything parked there refuses every edit — and, as the server currently
stands, the move *out* as well: `moveDocument` passes no override and rule 2 refuses `move` for
every actor, so nothing can leave `Unsorted/` from any surface.

**It is never a destination you file into.** It is the app's record of a decision it declined to
make, and an agent that files there converts "nobody has placed this yet" into a folder that grows
faster than anyone empties it — while making each document read-only on arrival. If you do not
know where a document belongs, name a real folder or let the convention route it and leave it
unfiled. Unfiled is honest and stays writable; `Unsorted/` is neither.

### Routing is the server's, by convention

**Nothing in the tool surface picks a folder except `create_document`'s optional `folder`.** There
is no folder tool and nothing that reparents a document within a project — `update_document`'s
`project` moves one to another project, where it lands unfiled, and that is the only relocation on
the surface. Placement is otherwise inferred from the title and type you send:

- an `Amendment — ` prefix → the release box's `Amendments/`;
- type `research` → the release box's `Research/` — or the project's `Reference/Research/` when the
  title says `cross-release`, when no box is open, or when several are open and none is named,
  because research is cross-release unless somebody says otherwise;
- type `agent_prompt` → the release box's `Agent Briefs/`;
- everything else lands unfiled, which is a legal resting place and not a failure.

`folder` takes a template-slot slug or a `/`-joined path and wins over convention entirely. It
grants **placement, never permission** — the same guard then runs against the folder it named, so
naming a living folder buys you a rule 3 refusal rather than a way past one. The slug form only
ever reaches an open box; the path form reads folder names literally and can reach a frozen one,
where rule 1 is waiting.

## Reporting progress without noise

The activity log is something a human reads. Treat it that way.

- **One `add_progress_note` per wave or session**, not per story and never per commit. "Wave 2
  of KAIR-179 merged green: KAIR-183, KAIR-184, KAIR-192" is a note. "Committed 3 files" is noise.
- **`update_item_status` when the item's state actually changed**, mirroring the Jira status —
  `blocked` included. The app refreshes item status from Jira on its own, so this is for
  keeping the dashboard live *between* refreshes, not for driving it.
- Never write a note to say you are starting. Start, then say what happened.
- **`human_todo` for the things you cannot settle yourself.** A credential you do not have, a
  decision that is not yours, an "is this what you meant". Filing one is not an escalation and
  not an apology — it is the only way an ask survives the session it was made in. Prefer it to
  a note that merely mentions the problem, and prefer the note's own prose for everything you
  DID handle.
- **You can never close one.** Closing, dismissing and assigning are human acts and no tool on
  either surface performs them. Do not file a todo and then report the work as complete.

## The ledger entry

A note is prose for a person. **A ledger entry is one line for a program**, written through the
same `add_progress_note` tool, and it exists because of a specific class of failure: two agents
reported success and produced zero commits; a command reported green while skipping 38 of 39
tests; a falling total read as a pass. Each was killable by one scalar the reporter could have
emitted at no cost. The entry is that scalar, made routine.

### The shape

The sentinel `ledger/1`, one space, then one JSON object — **all on one line, with nothing
before the sentinel**. The activity feed renders a row's message as a single line inside a flex
row, so an entry split across lines renders as a run-on and a program looking for the sentinel at
position zero will not find it.

Required on every claim:

- `item` — the plan item's own identifier, exactly as `get_plan` returns it and
  `update_item_status` accepts it. **Never its title.** The plan write path matches items by
  trimmed lowercase title, and titles get edited; an entry keyed by one stops resolving the day
  someone fixes a typo.
- `claim` — exactly one of `built`, `blocked`, `verified`, `refuted`.

Required per claim:

- `built` — `branch`, a ref name; `commits`, an array of **full** object names; and `tests`, an
  object carrying all four of `cmd`, `passed`, `failed`, `skipped`.
- `blocked` — `blocked_by`, naming what is needed *and* who or what can supply it.
- `verified` — nothing beyond the always-required pair.
- `refuted` — nothing beyond the always-required pair. One without `notes` is technically valid
  and says nothing useful; put the reason there.

Optional on any claim: `notes`. It absorbs what the implementer's report block calls
`spec_ambiguity` — there is no separate ambiguity field.

**`skipped` is not decoration.** It is the single field that separates a real green from the run
that reported green while skipping almost everything, and a `tests` object missing it is
unfalsifiable. The same reasoning makes `commits` full object names rather than abbreviations: a
reader can check a full name in one command, and an abbreviated example teaches an abbreviation.

**`built` means the code exists and the stated checks ran.** It does not mean finished. Finished
needs a merged pull request and a human transition, and no agent claim asserts either.

Forbidden outright: **any self-declared identity, and any date, duration, estimate or
timestamp.** Identity comes from the row's own credential column and time from its `created_at`,
which the write path deliberately does not accept from a caller. An entry that names its own
author is a claim about who wrote it rather than a record of it.

A worked example, and the object name is full length on purpose:

```
ledger/1 {"item":"a642b80e-9da1-4511-9769-d4c111f2c88d","claim":"built","branch":"story/p3-feed","commits":["9889edf6c1b4a0d2e7f3b58c94a1d0e6f2c7b345"],"tests":{"cmd":"bun run test","passed":2715,"failed":0,"skipped":0},"notes":"mockup already carried the design; no write-back needed"}
```

### Write the entry before the status

Write the ledger entry **before** the `update_item_status` call that moves the same item, and
the reason is the crash in between: an entry with an unadvanced status leaves a claim a resumer
can verify and act on, while the reverse leaves an item marked done with nothing behind it.
Neither write is conditional on the other and nothing attempts atomicity — the driver has no
transactions, so there is no sequence to enforce, only one that is cheaper to recover from.

**Nothing enforces this ordering and nothing reports a violation.** The two writes are
independent tool calls chosen by you. What a reader does see is an item carrying a status with no
claim behind it, which is the visible half of the same failure. This instruction is the entirety
of its own enforcement, which is exactly why it is written down rather than assumed.

The Jira evidence comment in `jira-ops` is unchanged and is not replaced by any of this: that
comment is written for a human reading Jira, the entry is written for a program reading the app,
and neither substitutes for the other.

### Checking someone else's claim

A verification is itself a ledger entry — same sentinel, same single line, the same `item` — with a
`claim` of `verified` or `refuted`. It **restates the fields it checked with the values it
observed**, and it does not point at the entry it disputes. The reason is mechanical rather than
stylistic: `add_progress_note` hands back no row id, so there is no identifier a writer could put
in an entry and nothing a later reader could resolve it against. The comparison is a diff the
reader performs between two entries naming the same item, not a link the writer maintains.

Put what you actually observed in `notes` — the object name that resolved, the ref that existed,
the command you ran and the three counts it printed. A `verified` entry whose `notes` restate
nothing is one more assertion, and the register already holds the assertion it was meant to check.

**A `refuted` entry leaves the claim it refutes standing.** It does not alter it, hide it or
supersede it. Both entries stay in the feed, and the disagreement between them is the finding —
the register is more useful for holding two answers than it would be for holding one. That is not
a policy anyone has to honour: `activity_log` has a single insert path and no update path, so **a
correction is a new entry** by construction rather than by rule, and what was written once is what
the record will always say was written.

```
ledger/1 {"item":"a642b80e-9da1-4511-9769-d4c111f2c88d","claim":"refuted","notes":"branch story/p3-feed exists and commit 9889edf6c1b4a0d2e7f3b58c94a1d0e6f2c7b345 resolves, but bun run test at that commit printed 2715 passed / 0 failed / 57 skipped, and the entry claimed 0 skipped"}
```

Converge's findings are entries under exactly these rules. A converge pass concluding that an item
is unbuilt is making a claim, from a credential, about the state of the world — the same kind of
thing as the `built` entry it disagrees with, and worth no more automatically for having been
produced by a different procedure.

**The precondition, and it is not a footnote.** The identity beside an entry names a *credential*,
not an agent. Where the agents in one run share a credential — one token in one `mcp.json`, which
is the documented headless case — every entry that run writes carries the same identity, and a
`verified` entry is byte-indistinguishable from the claimant verifying itself. Both supported
credential kinds land here: the OAuth path stores the client application's own id, and a legacy
token resolves to exactly one row no matter how many agents read it. So until credentials are
issued per agent, **a reader treats every identity within one run as one identity** and weighs a
`verified` entry accordingly. An independent check is a second *credential*; a second prompt is
not one.

Where the fix lives, so this reads as a gap and not a lament: credentials are minted in Settings
one at a time, and what each subagent's `mcp.json` carries is a harness decision, so **per-agent
issuance is the harness spec's to settle** rather than anything this file or the app's write path
can reach. The trigger for deleting this paragraph is that spec settling per-run credential
issuance — or a `verified` entry turning up with the same identity as the claim it checks, which
is the same hole appearing in the record instead of in prose.

## What agents write, and what the app writes

This is the line that keeps the dashboard trustworthy:

**The app owns structure.** Pushing the plan to Jira, publishing documents to Confluence, and
maintaining the `sync_mappings` that tie them together — all of that is the app's, triggered by
the user or by the app's own Sync tab. An agent that creates Jira issues directly produces
issues with no mapping, which the app's status refresh will never see. The Plan tab then goes
quiet and nobody knows why.

**Agents own runtime.** Transitions, comments, subtask closure, progress notes, item status.
The things that happen while work is being done.

So: never call `createJiraIssue` for plan structure, and never publish a page that the app also
manages. Write the plan into Kairoku with `upsert_plan` and let the app push it.

## What is still the human's click

Authoring happens *in* Kairoku through the write tools. What the server does **not** expose is
anything that fires the app's outbound sync — and that omission is deliberate:

| Still manual | Why |
|---|---|
| Creating a project or release | Quick capture is the app's front door, and stage is a human judgment |
| **Push plan → Jira** (Sync tab) | The only writer that creates `sync_mappings`. No `push_plan` tool exists |
| **Publish document → Confluence** | Same: the publish path is what records the page mapping |
| Changing a release stage | A gate, not a status |

So the shape is: **agents write into Kairoku, the human pushes out of it.** Write the document
or the plan, then say plainly what the user needs to click and what scope to push. Do not
route around it by writing to Confluence or Jira yourself — that is the second-writer problem
this whole protocol exists to prevent.

One consequence worth knowing: a plan written by `upsert_plan` carries no mappings until it is
pushed. If its items already have Jira issues, pushing again duplicates them rather than
linking. `get_plan` and check for existing Jira keys before telling anyone to push.

**Always** `add_progress_note` at the end of a session or wave, so the dashboard is not blind
to work that happened outside it.

## Signing in

The server is an OAuth resource server and the plugin sends no token of its own. A call against
a signed-out server comes back 401 with a `WWW-Authenticate` header, the client reads the
authorization server out of it, and the user finishes in a browser. Once per machine, not once
per session — the grant survives restarts. Nobody pastes a token any more.

An agent cannot do this for the user. If the tools are missing or every call 401s, name the
command and move on:

| Client | Sign in with |
|---|---|
| Claude Code | `/mcp` → **kairoku** → **Authenticate**, or `claude mcp login kairoku` |
| OpenAI Codex CLI | `codex mcp login kairoku` |
| Augment auggie | the TUI's `/mcp` popover, which offers it once the server 401s |

Headless runs have no browser, so a token from Settings → MCP access still works there — but the
run supplies it, not the plugin (Codex's `bearer_token_env_var`, or a `--mcp-config` carrying the
header). Never ask an interactive user for one: Claude Code treats a rejected `Authorization`
header as a failed connection and stops, so a stale token reads as an outage and the sign-in
prompt never appears.

## When the server is not connected

Kairoku is optional. If the MCP server is absent, unconfigured, or signed out, say so once — with
the sign-in command if that is what it needs — then carry on. Jira and Confluence are enough to
run the loop. Do not fail a story because the dashboard is unreachable, and do not silently skip
the progress note without mentioning it.
