---
id: R1
title: Ground the design in the current MCP spec
type: research
labels: [wayfinder:ticket, wayfinder:research]
status: open
assignee:
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
