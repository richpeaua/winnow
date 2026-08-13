# Changelog

All notable changes to Winnow are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Real-server benchmark** (`bench/real-servers.mjs`, `npm run bench:real`): drives actual MCP servers (`server-everything` + `server-filesystem`) over stdio and reports context reduction and the #4–#7 scale work with real payloads and a real BPE tokenizer. Results in [`bench/REAL-RESULTS.md`](bench/REAL-RESULTS.md): 90.4% fewer tool-definition tokens (27 real tools), 60–80% off real tool results via the cap. Honest finding recorded: upstream pooling (#7) gives no gain for async servers (which multiplex a single connection) — it's for genuinely serial upstreams.
- **Public/hosted MCP benchmark** (`bench/public-mcp.mjs`, `npm run bench:public`): drives real public MCP servers over the Streamable-HTTP transport (DeepWiki, GitMCP; no auth) — validating transport + auth + search + result cap end to end against servers we don't control. Results in [`bench/PUBLIC-RESULTS.md`](bench/PUBLIC-RESULTS.md): 75% off a real remote doc payload on a ~450 ms round-trip. Point `WINNOW_MCP_URL`/`WINNOW_MCP_TOKEN` at an authed server (e.g. GitHub's hosted MCP, ~50+ tools) to fold in a big catalog.

### Fixed

- **Result cap now honors an injected tokenizer on text payloads.** The token cap truncated string/text results to `maxTokens × 4` characters (hardcoding the ~4-char/token approximation), so with a real tokenizer a dense text blob (e.g. a file read) overshot the cap badly (~2×). It now binary-searches the serialized prefix against the actual counter, so `maxTokens` is a true ceiling for text as well as structured results. Found by the real-server benchmark.

## [0.2.0] — 2026-08-05

Multi-agent scale ([epic #8](https://github.com/Cambrionic/winnow/issues/8)): four gaps that surface when many agents share one gateway, each with a measured before/after and Node 20 + 22 CI.

### Added

- **Bounded sandbox worker pool** (#4): `run_code` execs now share a capped pool of reused workers (fresh QuickJS context per exec) with a queue + backpressure, instead of spawning an unbounded worker per exec. Sandbox memory is now flat at `maxWorkers × (32 MB + heap)` regardless of concurrent-agent count (measured: ~129 MB at 20 concurrent execs, vs ~641 MB before). Configurable via `sandbox: { maxWorkers, maxQueue, queueTimeoutMs }`.
- **Off-thread local embedder** (#5): new `localEmbedder()` runs Transformers.js semantic embedding in a worker thread, so hybrid-search embedding no longer blocks the main event loop (measured: 6 ms max loop-gap while a 101 ms embed ran off-thread). Query-time embed failures now degrade to lexical for that search instead of throwing.
- **Per-agent auth passthrough / multi-tenant identity** (#6): a shared HTTP gateway can now act as a **distinct upstream identity per request** instead of one shared principal. `serveHttp` takes a `resolveAuth(req)` hook (or the batteries-included `forwardHeaderAuth({ server: header })`) that maps an incoming request to per-upstream bearers; config-only via `gateway.forwardAuth`. Plumbed through the SDK as `call(id, args, { auth })` / `exec(code, { auth })` → `upstream.callTool(name, args, ctx)`, with HTTP upstreams keeping a bounded LRU of per-identity connections. Strictly opt-in (default: configured identity).
- **Upstream connection pooling** (#7): a server can set `poolSize: N` to keep N replica connections and dispatch each call to the least-busy one, so a single-threaded upstream gets N parallel workers instead of serializing the fleet's fan-in. New `PooledUpstream` (transport-agnostic; wraps stdio or http). Replicas connect lazily (idle cost = one connection) and are reused; `poolSize: 1` (default) is unchanged single-connection behavior, and pooling leaves the catalog cache key intact.

### Fixed

- Worker entry points (sandbox + embedder) are now plain `.mjs` so they load natively in a `worker_thread` on Node 20 (a TS loader does not reliably apply to a Worker entry there) — fixes `run_code`/hybrid-embedding under Node 20.

## [0.1.0] — initial

First complete build of Winnow — an MCP client SDK that fights context bloat.

### Added

- **Progressive-disclosure catalog** (C1): full tool defs held internally; the model sees minimal entries. `searchTools → loadTool → call`.
- **Hybrid search** (S1): Orama BM25 + optional local embeddings (Transformers.js) fused with RRF; graceful lexical-only fallback. Validated at 100% recall@8 (hybrid), 88% (lexical).
- **Deterministic result-filter** (F1): JMESPath projection + a hard token cap the agent can only lower; base64 stubbing.
- **Config + `${ENV}` secrets** (G1), zod-validated, fail-fast.
- **Code-execution sandbox** (X1): synchronous QuickJS-WASM in a `worker_thread` with an Atomics bridge; capability-injected; `run_code` composes many calls server-side.
- **Transports**: stdio and Streamable-HTTP, both live-verified. Full browserless HTTP auth: static bearer, pre-provisioned OAuth, and the client_credentials grant (P2).
- **Gateway** (P4): run Winnow as an MCP server exposing 4 meta-tools over stdio/HTTP — installable into any MCP host.
- **Claude Code plugin** (P5) + marketplace.
- **Persistent catalog cache** (P1): disk cache keyed by upstream identity; zero-connection warm start; degrade-to-stale; `refresh()`.
- **Live `tools/list_changed` watch mode** (P6).
- Packaged for publish: `dist` build, types, and the `mcp-winnow` bin.

### Notes

- Measured context reduction: ~89.8% tool-definitions at rest; ~10× (call) / 26× (exec) end-to-end on the reference benchmark. See [`bench/RESULTS.md`](bench/RESULTS.md).
- Deferred: honoring per-response `ttlMs`/`cacheScope` cache hints (pending an MCP SDK/spec upgrade — no server emits them yet).
