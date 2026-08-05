<!-- label: wayfinder:map -->
# MCP-Client: a context-bloat-killing agent SDK — design map

## Destination

A **locked, build-ready design spec + decision log** for `mcp-client`: an embedded TypeScript SDK that lets an agent talk to many MCP servers without paying the two context-bloat taxes — tool-definition bloat and tool-result bloat. Planning only: no implementation code is written while working this map. Done = every ticket closed and the spec assembled, with nothing left to decide before someone builds it.

## Notes

**Domain:** MCP client SDK design (TypeScript). Serves both attended (human-in-loop) and headless (autonomous/cron/CI) runs — every decision must hold in both.

**Framing locked during charting (not tickets — the ground the map stands on):**
- Integration surface = **embedded TS SDK** (`import { McpClient }`), not a standalone gateway server.
- Def-bloat fix = **progressive disclosure via hybrid lexical + semantic tool-search**; must degrade gracefully headless with no embedding model.
- Result-bloat fix = **deterministic result-filter**: static per-tool policy in config + agent-supplied projection override at call time.
- **Code-execution sandbox is in scope** for this spec (server→typed-module codegen; results filtered in-sandbox before hitting context).

**Skills each session should consult:** `grill-me` (grilling; stand-in for `/grilling` + `/domain-modeling`), research subagent for `research` tickets. Prototype tickets → `/prototype` if present, else a rough artifact.

**Standing preferences:** plan don't do (no code); plain hyphens not em dashes; concise reporting; ground claims in sources/spec.

## Decisions so far

<!-- one line per closed ticket: gist + link. -->
- [Ground the design in the current MCP spec](tickets/01-ground-mcp-spec.md) — spec rev 2026-07-28, SDK v2; stdio + Streamable-HTTP both headless-capable (env/bearer creds, no browser); index text = name/title/desc + schema prop descriptions; results = `content[]` + `structuredContent` + `isError` (no size cap); freshness via `nextCursor` + `list_changed` + `ttlMs`/`cacheScope`. [findings](research/R1-mcp-spec-findings.md)
- [Survey prior art for MCP context-bloat solutions](tickets/02-survey-prior-art.md) — code-exec pattern ~98% def savings but result-bloat unaddressed by existing gateways = **our edge**; stack = Orama (hybrid BM25+embeddings, lexical fallback) + JMESPath projections + QuickJS-WASM sandbox. [findings](research/R2-prior-art-findings.md)
- [Design the progressive-disclosure tool catalog & schema-loading model](tickets/03-catalog-progressive-disclosure.md) — 3-verb disclosure (`searchTools`→`loadTool`→`call`); eager-list-at-init then disconnect, lazy-reconnect per call (warm cache = zero connections until a call); at-rest entry `{id,name,1-line,server}` (full schema only on `loadTool`); disk cache default-on keyed by version+`ttlMs`; freshness via ttl + `list_changed` when live, snapshot headless; ≈20-40 tok/entry.
- [Design the hybrid lexical + semantic tool-search](tickets/04-hybrid-tool-search.md) — Orama BM25 + Transformers.js local embeddings, RRF fusion; pluggable `Embedder`; top-k=8 + score. **Validated (`bench/recall.js`): hybrid 100% recall@8, lexical-only 88% (80% paraphrase) → pre-provision the model for headless, add per-tool `aliases` + low-score `list_tools` escape hatch.**
- [Design the deterministic result-filter layer](tickets/05-result-filter.md) — **the differentiator**; JMESPath projection (config policy + agent override); pipeline select→project→cap→annotate; **cap is a hard ceiling the agent can only lower** (headless-safety); base64 images → reference stub.
- [Design the config & headless-safe secrets format](tickets/06-config-secrets.md) — `mcp-client.config.{ts,js,json,yaml}` + env + constructor; zod fail-fast; `${ENV}` interpolation only, no inline secrets; http auth = bearer/seeded-oauth/client_credentials, all browserless.
- [Design the code-execution sandbox runtime & security](tickets/07-code-exec-sandbox.md) — QuickJS-WASM + worker_threads, capability-injected, no ambient fs/net; every bridged `__mcpCall` still passes F1 filter; `exec` composes many calls, reduces before return.
- [Design the generated typed code API](tickets/10-generated-code-api.md) — one typed module per server (`mcp:github`), types from JSON Schema, in-sandbox only (zero model-context cost); same bridge/filter as `call`.
- [Design the public McpClient API surface](tickets/11-public-api-surface.md) — `init/searchTools/loadTool/call/exec/listServers/on/close`; two modes — direct SDK + 4 meta-tools (`search_tools/load_tool/call_tool/run_code`) = ~4 tools at the model layer.
- [Define the attended vs headless behavior contract](tickets/12-attended-headless-contract.md) — core fully non-interactive; mode is an input not a build flag; optional `onBeforeCall`/`onBeforeExec`/`logger` hooks; absent = headless.
- [Define the bloat-reduction success metric & token accounting](tickets/08-bloat-success-metric.md) — real tokenizer; targets ≥85% defs-at-rest, ≤cap per result, ~10× end-to-end; fixed 5-server/80-tool benchmark run attended + headless.
- [Assemble the build-ready design spec](tickets/09-assemble-spec.md) — **destination reached**; full spec + decision log at [docs/DESIGN.md](../docs/DESIGN.md).

## Not yet specified

<!-- in-scope fog; graduates into tickets as the frontier advances -->
- **Thin gateway adapter** — an optional, thin MCP-server shell over the SDK core, for reaching hosts whose code you don't own (Claude Desktop, Cursor, other-language hosts). Post-v1; wraps the same 4 meta-tools over MCP. Known cost: code-exec over the adapter degrades to a generic exec tool. *Only remaining in-scope fog.*

_The following graduated into tickets and are resolved (see Decisions so far): generated typed code API, public `McpClient` API surface, attended-vs-headless contract._

_Deferred to implementation (non-blocking; default direction set in [docs/DESIGN.md](../docs/DESIGN.md) §13): connection pooling / reconnect-backoff / per-call timeouts, detailed failure semantics, disk-cache eviction, npm packaging/versioning._

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->
- **Heavy standalone gateway as the core topology** — ruled out; the SDK is the core. A *thin* optional gateway adapter is in scope as fog (see Not yet specified), not this.
- **Building or hosting the upstream MCP servers themselves** — this SDK is a client of them.
