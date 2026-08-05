---
id: P6
title: Live tools/list_changed subscriptions + ttl hints
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

Split from [P1](13-persistent-cache-listchanged.md) (which delivered persistence). Make the catalog update itself while running, so a tool added/removed on a live upstream appears in `searchTools` without a restart or a manual `refresh()`.

- Add a **watch mode**: keep the chosen upstream connections open and register a `notifications/tools/list_changed` handler (via the SDK client's `setNotificationHandler`); on notification, re-list that server and patch the catalog + search index, then fire `'toolsChanged'`. Unsubscribe on `close()`.
- Surface the spec's **`ttlMs`/`cacheScope`** cache hints from `tools/list` responses through `UpstreamConnection.listTools` so the persistent cache (P1) can honor a server's own freshness hint instead of only the config/default TTL.
- **Incremental index patch** (nice-to-have): update only the changed server's entries in the Orama index rather than a full rebuild.

Design note: the current model connects to list and keeps the connection until `close()`; watch mode formalizes and opts into keeping connections live + subscribed. Must stay opt-in (headless one-shots don't want a long-lived subscription).

Acceptance: with watch on, a `MockUpstream` (extended to emit a change) — and a real server that supports `list_changed` — surface a new tool in `searchTools` without restart; the persistent cache respects a server-provided `ttlMs`.
