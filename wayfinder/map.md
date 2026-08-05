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

<!-- one line per closed ticket: gist + link. Empty until tickets resolve. -->

## Not yet specified

<!-- in-scope fog; graduates into tickets as the frontier advances -->
- **Generated typed code API** — the shape of the `server → TS module` codegen the sandbox executes against (naming, types from JSON Schema, how a call is written). Graduates once the catalog model and sandbox runtime resolve.
- **Public `McpClient` SDK API surface** — the actual class/method signatures (`searchTools`, `loadTool`, `call`, `exec`, lifecycle). Graduates once the core mechanisms resolve; it is their integration point.
- **Attended vs headless behavioral differences** — tool-approval hooks, interactive prompts, telemetry/logging verbosity. Graduates after the API surface.
- **Upstream connection lifecycle** — lazy vs eager connect, pooling, reconnect/backoff. Partly graduates from the MCP-spec research.
- **Caching & persistence** — search index + fetched schemas on disk; invalidation. Graduates after the catalog model.
- **Failure semantics** — upstream server errors, timeouts, partial results. Graduates after connection lifecycle.
- **Packaging & distribution** — npm layout, versioning, peer deps. Late fog.

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->
- **Standalone MCP gateway/proxy server** — topology decided as embedded SDK during charting. A gateway wrapper could be a later, separate effort.
- **Building or hosting the upstream MCP servers themselves** — this SDK is a client of them.
