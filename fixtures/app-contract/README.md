# The app's half of the MCP contract

`mcp-tools.json` is a **copy, byte for byte**, of `contracts/mcp-tools.json` in the Kairoku app
repository (`gitlab.com/owds-inc/kairoku/kairoku`) taken at **dev `52d7bf8b6bb017ea1cadeddf2cef22933771276d`**.
The app generates it with `bun run export:mcp-contract` from the same parser its own tool-table scan
uses, so it is what that scan computes rather than a second reading of the same source: every tool the
MCP endpoint registers with its top-level arguments (name and optionality), plus `upsert_plan`'s one
nested item shape. `src/mcp-tool-table-scan.test.ts` and `src/plugin-skill-lint.test.ts` read it, because
the app files they used to parse do not exist in this repository (DECISIONS §37.5b–e).

**Do not edit it, reformat it or sort it.** Its byte order is **code point, not `localeCompare`** — ICU
collation puts `needs_manual_check` before `needsManualCheck` and code point puts them the other way
round, so a "tidied" file fails the app's own currency test on a different machine. Refreshing it means
copying the app's current `contracts/mcp-tools.json` over it unchanged, which is a named item of the
**CLI release lane** (§37.5b): that is the one moment both repositories are in a single lane, so drift
between the plugin and the wire is caught at release time.
