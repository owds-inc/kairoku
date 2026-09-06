# UI story template

> **RETIRED by E9 (2026-08-24).** Constraint 6 — "the committed mockup outranks prose" — is
> withdrawn and `docs/design/kairoku-ui-mockup.html` has left the repo: the design is finalized,
> so there is no longer a live artifact for a story to check itself against. **The Visual target
> block and the side-by-side acceptance criterion are no longer required on a UI story.**
>
> The file is kept as a decision record, not as instructions. Everything below describes the gate
> as it operated, including why it was built (18 UI stories at 0% artifact citation; 250 confirmed
> audit findings) — which is the thing to read first if a future design change makes a conformance
> gate worth reinstating. Do not cite the artifact path below; it does not resolve.

**This is an addendum, not a second template.** Every story body has one shape — the six
sections defined in `plugin/skills/plan/SKILL.md` (Context, Objective, Implementation notes,
Acceptance criteria, Out of scope, Definition of done), opening with a `Satisfies:` line. A UI
story is that shape plus two additions: the **Visual target** block goes in **Context**, and the
**side-by-side criterion** goes in **Acceptance criteria**. Nothing here replaces a section or
adds a seventh.

Every Jira story that adds or changes anything a user can see MUST carry both. A UI story
missing the Visual target block or the side-by-side acceptance criterion is incomplete by
definition — bounce it back to the author before any code is written.

## Why this template exists

The design-conformance audit (`docs/audits/2026-08-14-design-conformance-report.md`) found that
all 18 UI stories in Sprints 1–9 had a **0% visual-artifact citation rate**. The screens were
built from prose descriptions and were structurally incapable of matching a design nobody
referenced: 53% of the 250 confirmed findings trace to mechanism "(d) built from prose —
implemented from a written description, never placed beside the frame." The stories were not
careless — they carried grep assertions, exact strings, and exit-code checks — but every one of
those catches regressions, and none of them can catch "this does not look like the design."
A story can pass every AC it has and still ship a screen that looks nothing like the frame,
which is precisely what happened. This template makes that failure mode impossible to write down.

---

## The template

Copy the block below into the story description and fill in every field. Nothing in it is
optional. The **Visual target** block sits inside the story's **Context** section, under the
`Satisfies:` line; the side-by-side criterion is one more bullet in **Acceptance criteria**,
alongside the story's functional ones.

```markdown
**Visual target:**
- Artifact (source of truth): `docs/design/kairoku-ui-mockup.html` (committed)
- Published copy: https://kairoku-ui-mockups-owds-colors-1.owds.io/
- Screen label(s): `data-screen-label="<Label>"` — one entry for EVERY mockup frame that
  contains UI this story touches (a board-card story that also changes a sidebar block names
  both `Board` and `Sidebar`)

**Done when:** <one sentence; must include "reads as the mockup side by side">

## Acceptance criteria

* [ ] **Side by side with screen `<Label>` at 1440×900, the following read the same:**
      <name specifically what must match — cover every category the story touches:>
      - **anatomy** — which elements exist, in what order, with what page furniture
        (header bars, hairlines, search fields, icons, footers, ghost cards)
      - **hues** — which colour goes where; count the accent occurrences on the frame
        (the accent appears exactly once per view, on the CTA)
      - **chips** — chip vocabulary: which values are chips vs bare text, fill vs outline,
        radius, mono vs sans, casing
      - **type tiers** — size, weight, casing and tracking per text level (title / label /
        value / meta), and which grey each level sits on
* [ ] <the story's functional/regression ACs — greps, exact strings, exit codes — as usual>
```

### Rules the filled-in template must obey

1. **Anchoring rule.** Cite the mockup's `data-screen-label` values, **never line numbers**.
   The published and committed copies differ in line count from historical citations; labels
   are stable, lines are not. A story that says "mockup lines 2049–2062" is malformed.
2. **Precedence order.** Where sources conflict: the committed
   `docs/design/kairoku-ui-mockup.html` ≻ the published URL ≻ `DESIGN_PROMPT.md` and both
   addenda. Prose never outranks the picture.
3. **Deviations are diffs, not prose (D-A7).** If the story deliberately diverges from the
   mockup — or improves past it — the accepted design fix is written back into
   `docs/design/kairoku-ui-mockup.html` **in the same story**: code and artifact change
   together, as a reviewable diff. A story that overrides the mockup with a written argument
   ("consistency wins; do not fork it") and leaves the artifact untouched recreates the
   original defect: the next audit will correctly flag the screen, and the next builder will
   correctly "fix" it back.
4. **The side-by-side AC names its comparisons.** "Matches the mockup" is not an acceptance
   criterion; it is a wish. The AC must enumerate what is being compared (see the four
   categories above) so a reviewer can fail it concretely.

### Capture protocol (for the side-by-side)

- **Viewport 1440×900, re-asserted immediately before every capture** — of both the mockup
  frame and the app. The audit lost a full round to a viewport left at 3840×2160 from an
  earlier test. Never trust a previously-set viewport.
- **Capture against a seeded account**: `bun run db:seed <clerk-user-id>`. Empty states hide
  controls — the audit reclassified findings as data artefacts because an unseeded account
  made real controls disappear. Capture seeded unless the story is *about* the empty state.
- Compare the frame whose `data-screen-label` the story names — verify you captured the right
  frame (the audit once diffed a byte-identical wrong screenshot for a round).

### Worked example of the required AC (Board, from the audit's confirmed findings)

> * [ ] **Side by side with screen `Board` at 1440×900, the following read the same:**
>       - **anatomy** — a 52px top chrome bar closed by a 1px hairline, containing the page
>         title with inline subtitle, a 240px search input, and the accent CTA (with leading
>         `+` glyph and trailing `⌘N` chip); six stage columns all fully visible with no
>         horizontal scroll; each column header carrying its 6px stage-hue dot with the count
>         adjacent to the label; the `+ New idea` ghost card at the foot of the Idea column;
>         the `› Parked · N releases` disclosure with no full-width rule above it
>       - **hues** — progress bars tinted by *stage* (indigo for building, green for shipped),
>         never by the brand accent; the accent `#f05459` appears exactly once on the frame,
>         on the CTA
>       - **chips** — the phase chip is a neutral recessive `P7/8` (obsidian fill, fog mono
>         text), not a saturated colour pill
>       - **type tiers** — stat-tile labels UPPERCASE, letter-spaced, ash, with value and
>         subtext sharing one baseline; the page title at the mockup's ~15px semibold scale,
>         not a ~30px heading

---

## Appendix — spot-check: KAIR-184 rewritten with this template

*(Worked example, clearly marked as such. KAIR-184 — "Make board release cards navigable and
finish the board + /projects surface" — was one of the best-specified UI stories in the
project. It shipped green on every AC it had, and the audit still confirmed 15 findings on the
Board frame and 14 on the Projects table frame.)*

### What KAIR-184 actually carried

- Visual target: `/Users/nihal/Work/OWDS/kairoku-plan/mvp/KAIROKU_UI.dc.html` — a path that
  does not resolve on the build machine — anchored by **line numbers** ("Board card = lines
  2049–2062").
- ACs of the form `grep -rn "stageChipClasses" … returns zero hits` and
  `bun run lint && bun run build both exit 0`.
- No side-by-side criterion of any kind.

### The same story's header and AC, rewritten under this template

```markdown
**Visual target:**
- Artifact (source of truth): `docs/design/kairoku-ui-mockup.html` (committed)
- Published copy: https://kairoku-ui-mockups-owds-colors-1.owds.io/
- Screen label(s): `data-screen-label="Board"`, `data-screen-label="Projects table"`,
  `data-screen-label="Sidebar"` (the story touches ReleaseCard)

## Acceptance criteria (visual — in addition to the story's functional ACs)

* [ ] **Side by side with screen `Board` at 1440×900, the following read the same:**
      the four bullets from the worked example above.
* [ ] **Side by side with screen `Projects table` at 1440×900, the following read the same:**
      - **anatomy** — the table sits inside a 12px-radius carbon card with a graphite ring;
        the app bar carries the inline `9 projects · 11 active releases` meta and a
        full-bleed closing hairline; the Integrations cell is one line of mono identifier
        badges, not two prose lines
      - **hues** — release-chip text tinted per stage; sidebar progress fill is stage-hued,
        not accent; the accent appears exactly once, on `+ New project`
      - **chips** — release chips outlined (graphite ring, 17px, 4px radius, mono); deploy
        state is a bare coloured mono word `▲ PREVIEW`, not a filled pill
      - **type tiers** — column headers UPPERCASE, tracked, ash — receding behind the data;
        row secondary text ash, two steps below the white project name; Updated stamps
        compact (`1d`, `2h`) as drawn on the frame
* [ ] **Side by side with screen `Sidebar` at 1440×900:** each project is a carbon card with
      a graphite ring; one line per release (`v1` mono badge · inline bar · `82%` · lowercase
      stage word right-aligned); no filled pills anywhere on the rail.
```

### Verdict: would this have caught what the audit found?

**Yes — every one of the 29 confirmed Board + Projects-table findings falls under a named
bullet above.** Concretely: the missing 52px top bar and search (Board #1), the sheared
Shipped column (#2), the missing stage dots (#3), the accent-filled progress bars (#8, and
Projects #9 — the audit's exact "one accent per view" violation), the teal phase pill (#9),
the CTA without `+`/`⌘N` (#11), the sentence-case stat labels (#6), the un-carded table
(Projects #1) and the filled deploy pill (#6) are each directly falsified by an anatomy, hue,
chip, or type-tier comparison the AC names.

Two failure modes needed template strengthening beyond the bare "name a screen" rule, and both
are now rules above:

1. **The multi-frame gap.** KAIR-184 touched the sidebar, but a story that named only `Board`
   would have skipped the 5 sidebar findings. Hence: one label for *every* frame containing
   touched UI (rule in the Visual target block).
2. **The prose-override gap.** KAIR-184 *saw* the mockup's compact `3d` stamp and explicitly
   ordered "do not add a short mode — consistency wins," leaving `1d ago` to become audit
   finding Projects #11. A side-by-side AC alone would have surfaced the conflict but the
   story had already pre-authorised losing it. Hence rule 3 (D-A7): a deliberate divergence is
   only legal as a same-story write-back diff to the artifact — prose never outranks the
   picture (rule 2).

With those two rules included, the answer is fully yes.

---

## Visual conformance gate — decision record (KAIR-202)

**Date:** 2026-08-14 · **Sprint 12, design-conformance epic (KAIR-195)** · **Decision: the standing
manual gate is retired.** Pixel-level fidelity is now enforced per story, at the story's close,
against the committed artifact — not by a scheduled manual sweep nobody owns.

---

### What KAIR-172 and KAIR-174 were

- **KAIR-172 — "Manual test — D.1 Design tokens & theme setup."** Render each restyled primitive
  (Button, Card, Badge, Input, Progress) and compare side-by-side against
  `mvp/KAIROKU_UI.dc.html`: hex/spacing, void canvas, Inter + Berkeley Mono, single-accent rule.
- **KAIR-174 — "Manual test — D.2 Retrofit Sprints 1-7 screens."** Screen-by-screen comparison of
  every retrofitted screen against its frame in the same file: surfaces, semantic accents, chip
  and type treatment.

`src/components/ui/design-tokens.test.tsx` deferred to this gate by name: *"Pixel-level fidelity
remains the manual gate (KAIR-172)."* KAIR-175 assigned visual conformance to the human gate
"because no automated check can make that claim."

### Whether they ever ran

**No.** The Jira record shows both subtasks created 2026-08-13 06:53 and resolved **Done** the
same morning (~11:04), with **zero comments** — no captured comparison, no findings, no evidence
of execution. They could not have run: both cite `mvp/KAIROKU_UI.dc.html`, a path on Nihal's
machine that decision **D12** explicitly kept out of the repo, so the file the gate needed was
unreachable by construction from the build environment. The 2026-08-14 design-conformance audit
(`docs/audits/2026-08-14-design-conformance-report.md`) then confirmed **250 findings** of
exactly the kind these gates existed to catch — conclusive evidence the gates provided no
coverage while reading as coverage on the board for eleven sprints.

### The decision

**Retire the standing manual gate. Do not resurrect it as a scheduled step.** A calendar gate
with no owner is the failure mode that just happened, not a fix for it. The replacements below
are runnable today, are owned by the story that needs them, and collectively cover everything
KAIR-172/174 were supposed to catch.

KAIR-172 and KAIR-174 stay closed as-is — they are already Done in Jira, and whether to annotate
or re-resolve them differently is **Neil's call**; this record and cross-reference comments on
both issues are the paper trail. No issue may claim them as coverage from this point on.

### What replaces each thing the gate was supposed to catch

| Gate was supposed to catch | Now covered by |
| --- | --- |
| Token hex drift / revert to shadcn defaults (172) | `design-tokens.test.tsx` (KAIR-171) — class→token→hex chain, every `bun test` |
| Mockup hues the app has no token for (172/174) | **KAIR-203** automated hue check — asserts every significant mockup colour maps to a `globals.css` token; design-referenced, not self-referenced |
| Primitive & screen side-by-side fidelity (172/174) | **KAIR-201** per-story side-by-side AC (`this file's template section above`) — anatomy, hues, chips, type tiers, per named `data-screen-label` frame |
| Single-accent-per-view rule (172/174) | Named bullet in the template's **hues** category ("the accent appears exactly once per view, on the CTA") |
| "Compared against the wrong thing" silent failures | **KAIR-225** self-checking capture protocol — dimension assert, `data-screen-label` assert at capture time, frame-hash uniqueness |
| Whole-surface sweep (174's screen-by-screen pass) | Sprint 12 remediation stories did it once per screen against the committed artifact; going forward, every UI story re-runs its own frames at close. Full audits (like 2026-08-14's) are commissioned deliberately, not standing. |

Status at time of writing: KAIR-196 (committed artifact, `docs/design/kairoku-ui-mockup.html`)
and KAIR-201 (template) are landed; KAIR-203 and KAIR-225 land this wave of Sprint 12. If either
of those two fails to land, the corresponding row above is uncovered and this record must be
revisited — do not let the retirement stand on replacements that never shipped.

### Who runs what, when

- **Per UI story, at the story's close** — the story's implementer runs the side-by-side AC:
  viewport 1440×900 (re-asserted immediately before every capture), seeded account
  (`bun run db:seed <clerk-user-id>`), against the **committed**
  `docs/design/kairoku-ui-mockup.html` frame(s) the story names by `data-screen-label`, using
  the KAIR-225 capture protocol. The reviewer fails the AC concretely per the template's four
  categories.
- **Every `bun test` run** — the design-tokens suite, and the KAIR-203 hue check once landed.
- **Deliberate divergence** — written back into the artifact in the same story (D-A7); prose
  never outranks the picture.
- **Full-surface audits** — at Neil's discretion, commissioned explicitly; never an unowned
  recurring calendar item.

Precedence: committed artifact ≻ published copy
(`https://kairoku-ui-mockups-owds-colors-1.owds.io/`) ≻ `DESIGN_PROMPT.md` and addenda.
