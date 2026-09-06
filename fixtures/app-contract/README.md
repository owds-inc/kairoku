# The app's half of the MCP contract

`mcp-tools.json` is a **copy, byte for byte**, of `contracts/mcp-tools.json` in the Kairoku app
repository (`gitlab.com/owds-inc/kairoku/kairoku`) taken at **dev `a4562fe552c1c6e082987b1f34dbbb75656773c0`**.
The app generates it with `bun run export:mcp-contract` from the same parsers and modules its own
scans use, so it is what those scans compute rather than a second reading of the same source. Four
top-level keys:

- `tools` — every tool the MCP endpoint registers with its top-level arguments (name and optionality);
- `upsertPlanItem` — `upsert_plan`'s one nested item shape;
- `docClasses` — the `doc_class` pgEnum's values, imported from the app's `src/db/schema.ts` (**not**
  off the wire; it is here for `src/plugin-shelf-scan.test.ts`, which used to parse that enum as text);
- `boxSlots` — the release template's box slots as `{ name, docClass }`, imported from the app's
  `src/lib/template/tree.ts`, for `src/plugin-slot-table-scan.test.ts`.

`src/mcp-tool-table-scan.test.ts`, `src/plugin-skill-lint.test.ts`, `src/plugin-shelf-scan.test.ts` and
`src/plugin-slot-table-scan.test.ts` read it, because the app files they used to parse do not exist in
this repository (DECISIONS §37.5b–f, §44.1). The app's `scripts/export-mcp-contract.test.ts` keeps every
key **fresh** (regeneration reproduces the committed bytes) and **non-vacuous** (each list is non-empty
and equals an independent derivation) — that currency test is why a copy here can be trusted at all.

**Do not edit it, reformat it or sort it.** Its byte order is **code point, not `localeCompare`** — ICU
collation puts `needs_manual_check` before `needsManualCheck` and code point puts them the other way
round, so a "tidied" file fails the app's own currency test on a different machine. The rule is total:
top-level keys, tool names and every list. Refreshing it means copying the app's current
`contracts/mcp-tools.json` over it unchanged, which is a named item of the **CLI release lane**
(§37.5b): that is the one moment both repositories are in a single lane, so drift between the plugin
and the wire is caught at release time.
