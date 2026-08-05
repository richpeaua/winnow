# mcp-client — design spec

A context-bloat-killing agent SDK for MCP. Build-ready design + decision log.
Grounded in MCP spec revision **2026-07-28** / SDK v2 (`@modelcontextprotocol/client` 2.0.0).

## 1. Problem & goal

Connecting an agent to many MCP servers imposes two context taxes:
- **Definition bloat** — every server dumps all its tool schemas into the model's context up front (tens of thousands of tokens before the first turn).
- **Result bloat** — raw tool responses (multi-KB JSON, base64 blobs) flood context.

**Goal:** an **embedded TypeScript SDK** that lets an agent use many MCP servers while paying neither tax, working **identically in attended and headless runs**. Existing gateways address def-bloat partially and result-bloat essentially not at all — result-bloat is our differentiator.

## 2. Architecture

Embedded SDK (`import { McpClient }`) — not a standalone gateway. Internally a multi-server MCP client that holds full tool defs privately and exposes a narrow, anti-bloat surface.

```
model / host agent
   |  sees only: search_tools, load_tool, call_tool, run_code   (~4 tools)
McpClient  ── catalog+index (all defs held internally) ── result-filter ── sandbox
   |                         |                         |
   └── stdio / Streamable-HTTP  ──►  github, slack, fs, postgres, … (N upstream)
```

**Two consumption modes, one surface:**
1. **Direct SDK** — the host calls typed methods from its own agent loop (primary target).
2. **Meta-tool adapter** — surfaces exactly four meta-tools to a model, so the model's tool list holds ~4 tools instead of hundreds. A later *thin gateway adapter* (deferred) wraps this same surface over MCP for hosts whose code you don't own.

## 3. Progressive disclosure — catalog & schema loading  *(C1)*

Lifecycle: **`searchTools → loadTool → call`**. The SDK holds full defs internally; the model only ever receives search hits + explicitly loaded schemas.

- **Build:** eager-list at init (connect each server once, paginate `tools/list`, index, then **disconnect**); lazy-reconnect a server only when one of its tools is `call`ed. With a fresh cache, init makes **zero upstream connections** until a call.
- **At-rest entry** (what a search hit costs): `{ id, name, summary, server }`, `summary` ≤ 1 line, ≈ 20-40 tokens. Full `inputSchema`/description/examples/`outputSchema` withheld until `loadTool` (accepts one or many ids).
- **Persistence:** disk cache default-on (`~/.cache/mcp-client/`), keyed by server identity/version + spec `ttlMs`/`cacheScope`; `cache:false` forces ephemeral.
- **Freshness:** honor `ttlMs`; when a connection is live, subscribe to `tools/list_changed` and patch incrementally; short headless runs use the snapshot.
- **Init failure:** a server that fails to list is skipped with a warning and its cached defs used if present (degrade, don't abort); opt-in fail-fast.

## 4. Tool search — hybrid, degrades gracefully  *(S1)*

- **Components:** Orama (BM25 + hybrid, zero-dep) + Transformers.js local embeddings (`Xenova/all-MiniLM-L6-v2`, 384d), fused with **Reciprocal Rank Fusion**.
- **Posture — auto-detect, hybrid-if-cached:** probe for a present/cached embedding model (`allowRemoteModels=false`); found → hybrid, absent → lexical-only. **Never auto-downloads.** Headless-with-no-model → lexical-only, silently. (Hard requirement, satisfied.)
- **Backend pluggable:** `Embedder` interface; default local, optional remote (Voyage/OpenAI) for higher recall.
- **Index:** name/title/description/param-descriptions/server (boost name/title; `annotations` excluded as untrusted). Returns top-k (default 8) entries + normalized `score` so the agent avoids loading wrong tools.

## 5. Result filter — the differentiator  *(F1)*

Deterministic, always-on. Pipeline per result: **select source → project → cap → annotate**.
- **Projection language: JMESPath** (`@jmespath-community/jmespath`, pure JS) for both config policy and agent override. (jq/JSONPath rejected.)
- **Source:** prefer `structuredContent`, else `content[]`.
- **Static per-tool policy (config):** `{ project?, maxTokens?, truncate?: 'head'|'tail'|'smart', paginate? }`.
- **Agent override:** `call(id, args, { project?, maxTokens? })`. Override replaces the projection, but **the size cap is a hard ceiling the agent can only lower** — the headless-safety invariant: an absent/forgotten projection can never leak an unbounded result.
- **Mixed content:** text → cap; **images/audio base64 → reference stub by default** (opt-in to include); `resource_link` → kept; `isError` → surfaced, still capped.

## 6. Code execution — sandboxed composition  *(X1, A1)*

- **Runtime:** QuickJS-WASM (`quickjs-emscripten`) wrapped in a `worker_thread` for timeout/memory. Pure-WASM (sealed, portable), capability-injected. `isolated-vm` opt-in perf tier; `node:vm`/`vm2` banned.
- **Reach:** only generated server modules + a return channel. No ambient fs/net/env/timers. MCP calls go through an injected `__mcpCall` host function that **applies the F1 filter** — code-exec never bypasses result-bloat protection; it adds cross-call filtering so only a small computed value returns.
- **Generated typed API:** `import { github } from 'mcp:github'; await github.listPullRequests({state:'open'})`. Types from `inputSchema`/`outputSchema` (JSON Schema 2020-12), materialized in-sandbox (zero model-context cost). Only imported servers generated.
- **`exec` vs `call`:** `call` = one tool; `exec` = compose/loop/join many calls and reduce before returning (biggest headless win — fewer round-trips, in-code filtering).

## 7. Public API  *(A2)*

```ts
class McpClient {
  constructor(config: McpClientConfig)
  init(): Promise<void>
  searchTools(query: string, opts?: { topK?: number }): SearchHit[]
  loadTool(id: string | string[]): ToolDef[]
  call(id: string, args: object, opts?: { project?: string; maxTokens?: number }): FilteredResult
  exec(code: string, opts?: { timeoutMs?: number; memoryMb?: number }): FilteredResult
  listServers(): ServerInfo[]
  on(event: 'toolsChanged', cb: () => void): void
  close(): Promise<void>
}
```
Meta-tool adapter surfaces `search_tools`, `load_tool`, `call_tool`, `run_code`.

## 8. Config & secrets  *(G1)*

- **Source:** `mcp-client.config.{ts,js,json,yaml}` (first found) + env overrides + direct constructor object. Precedence: defaults < file < env < constructor arg.
- **Schema (zod, fail-fast):** `servers{}` (stdio `command/args/env` | http `url/headers/auth`), optional per-tool `tools{}` filter policy (F1) and `search{}` boost (S1), `cache`, `defaults.maxTokens`.
- **Secrets — no inline, headless-safe:** `${ENV_VAR}` interpolation only. stdio via `env`; http via pre-provisioned `bearer` / seeded `oauth` tokens / `client_credentials` grant — all browserless. Interactive OAuth is attended-only and never required.

## 9. Attended vs headless  *(A3)*

Core is **fully non-interactive**; mode is an *input*, not a build flag. All interactivity is optional host hooks — absent hooks = headless.

| Concern | Attended | Headless |
|---|---|---|
| Call/exec approval | `onBeforeCall` / `onBeforeExec` may prompt | absent → auto-proceed |
| Embeddings | present → hybrid | absent → lexical-only, no download |
| Auth | interactive OAuth allowed | pre-provisioned creds only |
| Logging | verbose/human | structured JSON/quiet |

Invariants in both modes: F1 cap always applies; no ambient sandbox caps; no search network unless embedder configured; no secrets in config file.

## 10. Success metrics  *(M1)*

Counted with the target model's real tokenizer. Baseline = all schemas loaded + raw results.
1. **Defs-at-rest: ≥ 85% reduction** (model sees ~4 tools).
2. **Per-search:** top-k × ~20-40 tok, bounded.
3. **Per-call result: ≤ configured cap** (default ~2k tok) vs unbounded.
4. **End-to-end task: ≥ ~10× reduction.**

**Reference benchmark:** ~5 servers/~80 tools; task = *"find open PRs with no review in 7 days, post a one-line summary of each to Slack"*; run attended (hybrid) and headless (lexical-only). **Accepted costs (logged, not hidden):** small search/embedding latency; lexical-only recall risk (mitigated by RRF when a model is present); first-`exec` codegen time.

## 11. Component choices (from prior-art survey R2)

| Concern | Choice | Why |
|---|---|---|
| Lexical/hybrid search | Orama | zero-dep TS, BM25 + native hybrid |
| Local embeddings | Transformers.js all-MiniLM-L6-v2 | runs headless, no API; degrade to lexical |
| Fusion | RRF | robust rank combination |
| Projection | JMESPath (pure JS) | reshape JSON, no binary shell-out |
| Sandbox | QuickJS-WASM + worker_threads | sealed, capability-injected, portable |
| MCP client | `@modelcontextprotocol/client` v2 | implements spec 2026-07-28 |

## 12. Decision log (why, not just what)

- **Embedded SDK over gateway** — code-exec wants typed in-process access; a gateway forces everything through a generic tool call and loses type-safety. A *thin* gateway adapter is deferred for reach into hosts you don't own.
- **Auto-detect search over always-hybrid** — no surprise model downloads in locked-down CI; hard degradation requirement.
- **Hard cap the agent can't raise** — the one invariant that makes result-bloat safety hold even when the agent does nothing.
- **Filter inside the sandbox bridge** — code-exec must not become a bloat escape hatch.
- **Mode as input, not build flag** — one code path; "works in both" holds without special-casing.

## 13. Deferred to implementation (not blocking build)

Connection pooling / reconnect-backoff / per-call timeouts; detailed failure semantics (partial results); disk-cache eviction; npm packaging/versioning. Each has a default direction above; final tuning is builder discretion.

## 14. Out of scope

Heavy standalone gateway as the core topology; building/hosting the upstream MCP servers. (Thin gateway adapter = deferred fog, revisit after v1.)

## 15. Open risks

- Lexical-only recall in headless may miss paraphrased tool intent → mitigate with good `summary`/description authoring + optional remote embedder.
- QuickJS perf ceiling for heavy `exec` → `isolated-vm` opt-in tier.
- `outputSchema` not always provided by servers → return type falls back to generic `ToolResult`; projection still works on `structuredContent`/`content`.
