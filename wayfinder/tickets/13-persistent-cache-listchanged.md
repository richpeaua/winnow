---
id: P1
title: Persistent cache + list_changed subscriptions
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

The catalog + search index are currently in-memory, rebuilt every process. Implement the persistence and freshness the spec (C1) calls for:
- On-disk cache of the built index + fetched schemas (default `~/.cache/mcp-client/`), one entry per server keyed by server identity/version + the spec's `ttlMs`/`cacheScope` hints; honor `cache: false`.
- On init with a fresh cache, skip connecting entirely (the "zero connections until a call" property).
- When a connection is live, open `subscriptions/listen` with `toolsListChanged:true` and patch the index incrementally on `notifications/tools/list_changed`; re-list a server whose `ttlMs` expired.

Acceptance: a second process reuses a warm cache without re-listing; a tool added to a live server appears in `searchTools` without restart. Touches `src/catalog.ts`, `src/search.ts`, upstream connections.
