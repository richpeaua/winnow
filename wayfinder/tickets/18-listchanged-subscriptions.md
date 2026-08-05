---
id: P6
title: Live tools/list_changed subscriptions + ttl hints
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: closed
assignee: lpeaua
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

## Resolution

**Watch mode delivered.** Opt-in `watch: true`:
- Added `UpstreamConnection.watch(onChanged) -> unsubscribe`. `StdioUpstream`/`HttpUpstream` register the SDK's `ToolListChangedNotificationSchema` handler (`notifications/tools/list_changed`) on the live connection; `MockUpstream` gets `watch` + `emitToolsChanged()` for deterministic tests.
- `client.init()` (with `watch`) subscribes each capable upstream to auto-run `refresh(server)` on a change (re-list → patch catalog + index → rewrite cache → fire `'toolsChanged'`); `init().watching` reports which servers are watched. `close()` unsubscribes all.
- Tests: a change auto-indexes the new tool + fires the event with no manual `refresh()`; `close()` stops further callbacks. Suite 20/20.

**Deferred (external dependency):** honoring per-response **`ttlMs`/`cacheScope`** hints. Those fields are in MCP spec rev 2026-07-28, but the installed SDK (`@modelcontextprotocol/sdk@1.30.0`, 2025-11 spec) doesn't surface them on `tools/list` responses, so the plumbing would be dead code. Incremental index patch (vs full rebuild) also deferred — a perf nicety, not correctness.

## SDK-upgrade investigation (decided: keep deferred)

Investigated `@modelcontextprotocol/client` 2.0.0 (a real, published, ground-up rewrite; `@modelcontextprotocol/server` 2.0.0 also exists). Findings:

- **v2 does surface `ttlMs`/`cacheScope`** and ships a native, spec-correct response-cache engine (private/shared scoping, `MAX_CACHE_TTL_MS`, `ttlMs: 0` = immediately stale) plus a native `ClientCredentialsProvider`. Its cache overlaps our P1 disk cache and its auth overlaps our P2 `auth.ts` — but v2's default store is **in-memory (per-process)**, so it would *not* give our cross-process zero-connection warm start without writing a disk-backed store.
- **v2's `Client` API is drop-in for us** (`connect`/`listTools`/`callTool`/`setNotificationHandler`/`removeNotificationHandler`/`close` all present). Migration of `upstream/*.ts` would be clean.
- **Blocker to any real payoff:** connecting v2 to a live server (`server-everything`, `mode: 'auto'`) and calling `listTools()` returned `{ tools }` only — **no hints**. No off-the-shelf MCP server emits `ttlMs`/`cacheScope` yet, so the capability is **unverifiable end-to-end today**. And receiving hints requires modern-protocol negotiation, which for stdio costs **an extra probe spawn per connect**; a second SDK would also join `dependencies`.

**Decision:** keep deferred. The migration is correct-by-construction but dormant until a hint-emitting server exists to validate against, and it adds a per-connect probe cost + a second SDK for zero present-day benefit. Revisit when a real 2026-spec upstream server emits cache hints (then the payoff becomes testable). Investigation date noted so the landscape can be re-checked.
