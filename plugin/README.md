# kairoku — the Claude Code plugin

Connects a session to the Kairoku app over MCP with OAuth browser sign-in (no
pasted tokens), and ships the protocol skills (`jira-ops`, `git-pr`,
`kairoku-mcp`), the operating skills (`plan`, `next`, `wrap`), and the
`implementer` agent. Install:

```
/plugin marketplace add <path-or-url-of-this-repo>
/plugin install kairoku@kairoku-marketplace
```

Then `/mcp` → kairoku → **Authenticate**. The only config key is the app URL,
and it defaults to https://kairoku.io — a fresh install prompts for nothing.

## Verified clients (KAIR-301 sitting, 2026-08-18)

CIMD was not advertised at verification time (beta, support-gated), so every
registration below arrived by DCR (RFC 7591) by construction — confirmed
against the Clerk dashboard's OAuth applications list, where DCR clients
appear under machine-generated names.

| Client | Version | Registration route | Outcome |
|---|---|---|---|
| Claude Code | 2.1.234 | DCR + OAuth (plugin `.mcp.json`, no headers key) | ✅ Zero-prompt install, `/mcp` → Authenticate browser sign-in, all 11 tools listed and working |
| Codex CLI | 0.147.0 | DCR + OAuth (`codex mcp add kairoku --url …` + login) | ✅ Working after sign-in. One pre-auth startup warning from its rmcp transport ("relative URL without a base") before OAuth discovery kicked in; recovered on authenticate + relaunch |
| auggie | 0.35.0 | `auggie mcp add-json` (streamable http) | ✅ Configured and connected in the owner's quick check; full walk deferred by owner |

Token facts established at the same sitting: access tokens are JWTs
(`at+jwt`, ~1-day expiry), a refresh token is issued even when
`offline_access` is not requested, and revocation lags until token expiry —
see the Settings card copy and Decision Log D23/D24 for the full record.
