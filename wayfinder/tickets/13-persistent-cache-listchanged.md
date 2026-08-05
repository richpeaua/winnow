---
id: P1
title: Persistent catalog cache
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: closed
assignee: lpeaua
blocked_by: []
map: map.md
---
## Question

The catalog + search index are currently in-memory, rebuilt every process. Implement the persistence and freshness the spec (C1) calls for:
- On-disk cache of the built index + fetched schemas (default `~/.cache/mcp-client/`), one entry per server keyed by server identity/version + the spec's `ttlMs`/`cacheScope` hints; honor `cache: false`.
- On init with a fresh cache, skip connecting entirely (the "zero connections until a call" property).
- When a connection is live, open `subscriptions/listen` with `toolsListChanged:true` and patch the index incrementally on `notifications/tools/list_changed`; re-list a server whose `ttlMs` expired.

Acceptance: a second process reuses a warm cache without re-listing; a tool added to a live server appears in `searchTools` without restart. Touches `src/catalog.ts`, `src/search.ts`, upstream connections.

## Resolution

Split during build: this ticket delivered **persistence** (the "in-memory per process" gap); the **live `list_changed` subscription** half moved to [P6](18-listchanged-subscriptions.md) because it needs a live-connection watch mode that's a distinct design addition.

Delivered (`src/cache.ts`, catalog, client; `test/cache.test.ts`):
- `CatalogCache` — one JSON file per server under `~/.cache/winnow/`, keyed by a hash of the upstream's `identity` (stdio command / http url / `mock:<server>`). `cache: false` = ephemeral; `cacheDir` / `cacheTtlMs` configurable (default 1h).
- **Zero-connection warm start:** on a fresh cache hit `build` uses cached defs and never connects/lists (`init().fromCache` reports which servers). Verified: a second `Winnow` over the same identity lists 0 times.
- **Degrade:** a live-list failure falls back to a stale cache entry if present (not skipped), per C1.
- `client.refresh(server?)` — re-list, patch catalog + index, rewrite cache, fire `'toolsChanged'` (the manual/poll path; the automatic subscription is P6).
- 5 new tests (warm reuse, ephemeral, expiry, degrade, refresh). Suite 18/18.

**Deferred to P6:** honoring per-response `ttlMs`/`cacheScope` hints (we use a config/default TTL — the `UpstreamConnection.listTools` doesn't surface those hints yet) and automatic `subscriptions/listen` + incremental index patching.
