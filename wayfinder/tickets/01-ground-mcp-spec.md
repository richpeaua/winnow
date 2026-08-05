---
id: R1
title: Ground the design in the current MCP spec
type: research
labels: [wayfinder:ticket, wayfinder:research]
status: closed
assignee: research-subagent
blocked_by: []
map: map.md
---
## Question

What in the **current** Model Context Protocol spec and official TS SDK constrains or enables our design? Surface the facts later tickets wait on:
- Transports supported (stdio, Streamable HTTP, legacy SSE) and their headless implications.
- Tool definition shape: `inputSchema`, output/`outputSchema`, `annotations`, titles/descriptions — what we index for search.
- Tool result shape: content blocks (text/image/resource), structured content, `isError`, size/streaming behavior — what the result-filter operates on.
- Capability negotiation, pagination (`nextCursor`), and any list-changed notifications relevant to a live catalog.
- Auth: what the spec says about server auth (OAuth) and how a headless client pre-provisions credentials.

Deliver a findings doc (link from this ticket) citing the spec revision/date, so the spec we assemble is grounded, not guessed.

## Resolution

Findings: [research/R1-mcp-spec-findings.md](../research/R1-mcp-spec-findings.md). Spec revision **2026-07-28** (now stateless; prior stable 2025-11-25). SDK v2 `@modelcontextprotocol/client` 2.0.0.
- **Transports:** stdio (fully headless via env creds) + Streamable HTTP (stateless; headless bearer via `requestInit.headers`, seeded `OAuthClientProvider.tokens()`, or `client_credentials` grant — no browser). Legacy HTTP+SSE deprecated (fallback only).
- **Tool def indexable text** = name/title/description + schema property descriptions; `annotations` untrusted.
- **Result** = `content[]` blocks + `structuredContent` + `isError`; no size cap, no token streaming.
- **Freshness** = `tools/list` `nextCursor` pagination + `ttlMs`/`cacheScope` cache hints + `tools/list_changed` (needs `subscriptions/listen`).
- **Auth** = OAuth 2.1 + Protected Resource Metadata (RFC 9728); DCR deprecated.
