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

## Not yet specified

<!-- in-scope fog; graduates into tickets as the frontier advances -->
- **Thin gateway adapter** — an optional, thin MCP-server shell over the SDK core, for reaching hosts whose code you don't own (Claude Desktop, Cursor, other-language hosts). SDK stays the destination; the adapter graduates into a ticket after the public `McpClient` API surface settles. Known cost: code-exec over the adapter degrades to a generic exec tool (loses the typed in-process path).
- **Generated typed code API** — the shape of the `server → TS module` codegen the sandbox executes against (naming, types from JSON Schema, how a call is written). Graduates once the catalog model and sandbox runtime resolve.
- **Public `McpClient` SDK API surface** — the actual class/method signatures (`searchTools`, `loadTool`, `call`, `exec`, lifecycle). Graduates once the core mechanisms resolve; it is their integration point.
- **Attended vs headless behavioral differences** — tool-approval hooks, interactive prompts, telemetry/logging verbosity. Graduates after the API surface.
- **Upstream connection lifecycle** — connect model settled in the catalog ticket (eager-list-then-disconnect, lazy-reconnect per call); still open: connection pooling, reconnect/backoff, per-call timeouts.
- **Failure semantics** — upstream server errors, timeouts, partial results, and the init-listing failure policy (basic default set in the catalog ticket; details open).
- **Packaging & distribution** — npm layout, versioning, peer deps. Late fog.

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->
- **Heavy standalone gateway as the core topology** — ruled out; the SDK is the core. A *thin* optional gateway adapter is in scope as fog (see Not yet specified), not this.
- **Building or hosting the upstream MCP servers themselves** — this SDK is a client of them.
