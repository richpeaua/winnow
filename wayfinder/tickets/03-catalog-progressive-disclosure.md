---
id: C1
title: Design the progressive-disclosure tool catalog & schema-loading model
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: [R1]
map: map.md
---
## Question

How does the SDK expose N servers' tools without loading every schema upfront? Decide the def-bloat core:
- What lives in the always-present catalog entry per tool (name + one-line? + server), and what is withheld until loaded (full `inputSchema`, long description, examples).
- The disclosure lifecycle: `search → load schema(s) → call`. When are upstream servers actually connected — eager at init vs lazy on first touch?
- How the catalog is built and kept fresh (list-changed notifications, pagination), and whether it persists across process restarts.
- Token budget: rough target for catalog-entry size and how many tools stay "cheap" at rest.

Output: the catalog data model + disclosure state machine, precise enough to build.

## Resolution

**Disclosure lifecycle (3-verb facade):** `searchTools(query) → loadTool(id | id[]) → call(id, args)`. The SDK holds full tool defs internally; the model's context only ever receives search hits plus explicitly loaded schemas. `loadTool` accepts one or many ids (batch load).

**Catalog build — eager list, lazy connect:**
- At init, connect to each configured server once, paginate `tools/list` (honor `nextCursor`), build the in-memory index, then **disconnect**. A server's connection is re-opened lazily only when one of its tools is actually `call()`ed.
- With a fresh disk cache present, init skips connecting entirely — **zero upstream connections until a call**.
- A server that fails to list at init is skipped with a warning; if a cached entry exists, its defs are used (degrade, don't abort). `config` may opt into fail-fast. Detailed failure/backoff semantics deferred to the failure-semantics fog.

**Catalog entry at rest** (what a single search hit costs in context): `{ id, name, summary, server }`, where `summary` is a ≤1-line truncation of title/description. Full `inputSchema`, long description, examples, and `outputSchema` are withheld until `loadTool`. Search indexes the *full* text (name + title + description + schema property descriptions, per R1) even though only the summary is returned. `id` = stable `server:toolName`.

**Persistence — configurable, default on:**
- Cache the index + fetched schemas to disk (default `~/.cache/mcp-client/`), one entry per server keyed by server identity/version + the spec's `ttlMs`/`cacheScope` hints.
- `cache: false` forces ephemeral (CI hygiene / untrusted env).

**Freshness — adaptive to session length:**
- Honor `ttlMs`/`cacheScope`: an expired server entry is re-listed on next use.
- When a connection is live (attended/long-lived), subscribe to `tools/list_changed` (via `subscriptions/listen`) and patch the index incrementally.
- Short headless one-shots use the snapshot — no subscription.

**Token budget:** target ≈ 20-40 tokens per at-rest catalog entry; the only heavy per-tool payload is a `loadTool` schema, which is opt-in. Hundreds of tools stay cheap at rest — only searched/loaded tools ever cost real context. (This is the number the success-metric ticket, M1, will hold the design to.)
