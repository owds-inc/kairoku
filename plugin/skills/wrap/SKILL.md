---
name: wrap
description: Close a working session — one line on the Kairoku dashboard via add_progress_note, plus item statuses that actually changed. Use when the user says they are done, asks to "wrap up", or a session is ending without its record written.
user-invocable: true
disable-model-invocation: true
argument-hint: "[note to include]"
---

# Wrap

Close the session so the next one — yours or another agent's — can pick it up cold. The
record is **one line on the dashboard**, not an essay anywhere.

1. **One `add_progress_note`** on the resolved project (see `kairoku-mcp`), written from what
   actually happened in *this* session, not from the plan.

   **Belongs in the note:** what moved (issue keys, a merged PR, a spec approved) and what is
   blocked with the one-word why. That's it — one line, at most two.

   **Does not belong:** commit counts, file lists, what you intend to do next time,
   restatements of the plan, or anything the dashboard already computes. "Committed 3 files"
   is noise; "KAIR-42 done, PR #7 open; KAIR-43 blocked on missing Test notes" is a note.

2. **`update_item_status`** for any plan item whose state genuinely changed this session and
   Jira doesn't yet reflect — `in_progress`, `blocked`, `done`. Item ids come from `get_plan`.
   Skip items the app will refresh from Jira on its own; this is for keeping the dashboard
   live between refreshes, not for driving it.

3. **Sweep the open release's `Amendments/`.** List the amendments in the open box that carry **no
   disposition footer** — a line beginning `> Disposition:`. That absence is the whole definition of
   *pending*: there is no status column, no flag, nothing else to read.

   With the eleven tools: `list_documents(project)`, keep the titles starting `Amendment — ` (the
   `(vN)` suffix, when a title has one, names the box), then `get_document` each and look for the
   footer line. Report the ones missing it, by title.

   **Why it is worth running now.** The ship gate reads exactly the same absence. A move to
   `shipped` turns every pending amendment into a **block**-severity gap and refuses the transition
   outright — `Cannot ship <version>: resolve first — …` — where every other missing slot only warns.
   So the pending set you list here IS the set that will stop the ship, and it is cheap to clear a
   release ahead of the gate and expensive to discover it at the gate.

   **Sweep, don't dispose.** A disposition footer is written by the app when a human applies the
   amendment into its parent or defers it (a defer writes a Decision Log row). Hand-writing
   `> Disposition:` into an amendment clears the gate without the change ever reaching the parent —
   that is falsifying the record, not wrapping a session.

4. **Reply** with the note text and the single thing to run next session (the `/kairoku:next`
   answer, one line).

If nothing happened worth recording, say so plainly and write nothing. A dashboard of
manufactured progress is worse than a gap.

If the Kairoku server is signed out or absent, give the note text to the user with the
sign-in command (`/mcp` → **kairoku** → **Authenticate**) instead of silently skipping it.

`$ARGUMENTS`, if given, is a note from the user to fold in.
