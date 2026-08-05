# Changelog

All notable changes to Winnow are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Bounded sandbox worker pool** (#4): `run_code` execs now share a capped pool of reused workers (fresh QuickJS context per exec) with a queue + backpressure, instead of spawning an unbounded worker per exec. Sandbox memory is now flat at `maxWorkers × (32 MB + heap)` regardless of concurrent-agent count (measured: ~129 MB at 20 concurrent execs, vs ~641 MB before). Configurable via `sandbox: { maxWorkers, maxQueue, queueTimeoutMs }`. Part of the [multi-agent scale epic](https://github.com/richpeaua/winnow/issues/8).

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
