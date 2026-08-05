# R2 — Prior Art: Context-Efficient MCP Tooling (Findings)

Scope: prior art + TS building blocks for an embedded SDK that lets one agent use many MCP
servers without context bloat (tool-definition bloat + tool-result bloat). All claims cited.
Compiled 2026-08-04.

---

## 1. Anthropic guidance: code execution + progressive disclosure

### 1a. "Code execution with MCP: building more efficient AI agents"
- Source: Anthropic Engineering, published **2025-11-04**, authors Adam Jones & Conor Kelly.
  https://www.anthropic.com/engineering/code-execution-with-mcp
- **Pattern:** Do not load all MCP tool defs into context. Instead present each MCP server as a
  directory of TypeScript files (e.g. `./servers/google-drive/getDocument.ts`). The agent writes
  code that imports/calls tools as a normal API, and *lists directories / reads a tool file only
  when it needs that tool* = "progressive disclosure." Intermediate tool results stay in the code
  runtime and never round-trip through the model context.
- **Claimed savings:** worked example **150,000 → 2,000 tokens = 98.7%** reduction.
- **Trade-offs (stated):** "code execution introduces its own complexity" — needs a secure
  execution environment with sandboxing, resource limits, and monitoring; operational overhead and
  security surface that plain tool-calls avoid. Benefits must be weighed against those costs.

### 1b. "Advanced tool use on the Claude Developer Platform" (productized version)
- Source: Anthropic Engineering, published **2025-11-24**.
  https://www.anthropic.com/engineering/advanced-tool-use
- **Tool Search Tool:** mark tools `defer_loading: true`; model initially sees only the search tool
  + high-priority (`defer_loading: false`) tools. It searches, and only matching defs get loaded.
  Claimed **~72K → ~500 tokens upfront (~85% reduction)** for 50+ MCP tools. Accuracy: Opus 4
  **49% → 74%**, Opus 4.5 **79.5% → 88.1%** with Tool Search enabled.
- **Programmatic Tool Calling:** model orchestrates tools in generated (Python) code inside a
  sandbox; only final output enters context. Claimed **43,588 → 27,297 tokens = 37%** on research
  tasks; small accuracy gains (GAIA 46.5→51.2%).
- Takeaway for us: Anthropic ships two levers — (i) defer/search over definitions, (ii) run
  orchestration in a sandbox so results don't bloat context. Our SDK should implement *both*.

Third-party validations of the code-exec pattern report 80–98% reductions (Medium writeups;
modelcontextprotocol Discussion #629 claims 98% over 112 GitHub tools) — directionally consistent
but not independently audited; treat the ~85–98% band as the credible range.

---

## 2. Tool-search / RAG-over-tools / dynamic tool loading

**Core recipe (RAG-MCP):** embed tool name+description into a vector space, embed the user query,
rank tools by semantic distance, inject only top-k schemas. Reported >3x selection accuracy and
>50% prompt-token reduction vs loading all tools. (Speakeasy / WRITER writeups.)

**Wrapper pattern (dynamic discovery):** expose 3 meta-tools instead of N real tools —
`searchTools`, `getToolDefinition`, `useTool`. Model drills down on demand. (HasMCP.)
https://hasmcp.substack.com/p/prevent-mcp-context-bloating-with

**Ranking — concrete benchmark (StackOne, 270 tools, 2,700 cases):**
https://www.stackone.com/blog/mcp-tool-search-bm25-tfidf-hybrid/
- BM25 alone: **14% Top-1** — common verbs ("create","send") dominate, drown provider terms.
- TF-IDF alone: **20.8%** (rarity weighting helps).
- Hybrid `0.2*BM25 + 0.8*TF-IDF`: **21.2%**, runs <1ms, zero API calls.
- Embedding search: **38% Top-1** but +50–200ms latency + infra.
- Guidance: lexical/hybrid is the "zero-API sweet spot" **under ~2,000 tools (~10–30 servers)**;
  add embeddings only past that scale. They use **Orama** for BM25 + custom TS for TF-IDF.
- Note: these absolute Top-1 numbers are low because it's a hard 270-tool retrieval task; the
  *relative* ordering (lexical < TF-IDF < hybrid < embedding) is the reusable signal.

Common production stack: combine BM25 + embedding scores via **Reciprocal Rank Fusion**.
Known projects: RAG-MCP (paper/pattern), HasMCP, MCPProxy (BM25 tool discovery, moving toward
hybrid), StackOne toolset.

---

## 3. Open-source MCP gateways / proxies / routers

Index: **e2b-dev/awesome-mcp-gateways** — https://github.com/e2b-dev/awesome-mcp-gateways

| Project | What it does | Def-bloat handling | Result-bloat handling |
|---|---|---|---|
| IBM ContextForge (mcp-context-forge) | Federates MCP + A2A + REST/gRPC; guardrails, plugins | Aggregation/routing; virtual servers curate tool subsets | Not a focus |
| Microsoft MCP Gateway | Reverse proxy / mgmt layer for k8s | Routing/scaling | No |
| Obot | Self-hostable gateway, central control plane | Governance + tool curation | No |
| MetaMCP | Servers→Namespaces→Endpoints; enable/disable individual tools; middleware | Manual per-tool enable/disable; middleware can filter | Middleware hook exists but not built-in trimming |
| AIRIS MCP Gateway | Docker multiplexer, **60+ tools behind 7 meta-tools** | Yes — meta-tool facade (closest to our need) | No |
| adamwattis/mcp-proxy-server | Aggregate many servers behind one interface | Routing only | No |
| AgentGateway (Linux Foundation) | LLM routing + MCP + A2A single plane | Routing | No |
| MCPProxy | Local proxy w/ **BM25 tool discovery** | Yes — search-based discovery | No |

**Gaps (the opening for our SDK):** the ecosystem is heavily weighted to *aggregation, transport
bridging, security/governance, observability*. Definition-bloat is addressed only by a few via
manual enable/disable (MetaMCP), meta-tool facades (AIRIS) or search (MCPProxy). **Tool-RESULT
bloat is essentially unaddressed** — almost none trim/project large JSON tool outputs before they
hit context, and none pair on-demand schema loading with a code-exec/result-filtering phase in one
embeddable TS library. That combination is our differentiator.
(Overviews: chatforest.com/reviews/mcp-proxy-router-aggregator-servers, getmaxim.ai best-oss-gateways-2026,
composio.dev best-mcp-gateway.)

---

## 4. TS building blocks (packages + maturity)

### 4a. Lexical / BM25 search for Node
- **Orama** (`@orama/orama`) — TS, zero-dep, <2kb, runs browser/server/edge; full-text (BM25) +
  vector + **native hybrid** with tunable weights; built-in stemming/tokenization. **Recommended
  primary** — it's the same lib StackOne used and it grows cleanly from lexical → hybrid when we
  later add embeddings. Mature, actively maintained.
  https://github.com/oramasearch/orama · https://www.npmjs.com/package/@orama/orama
- **MiniSearch** — tiny in-memory full-text engine, great DX; good fallback if we want minimal deps.
- **FlexSearch** — fastest for large corpora, but heavier API/ESM quirks; overkill at <2k tools.
- **wink-bm25-text-search** — explicit textbook BM25 if we want pure BM25 scoring control.
- **lunr / elasticlunr** — older, less maintained; avoid for new work.
Recommendation: **Orama** as the search substrate (lexical now, hybrid-ready). Keep a MiniSearch
path only if bundle size becomes critical.

### 4b. LOCAL embeddings, headless, no external API
- **Transformers.js** (`@huggingface/transformers`, formerly `@xenova/transformers`) — runs ONNX
  models fully local in Node via onnxruntime-node; no GPU, no API. Feature-extraction pipeline
  yields sentence embeddings.
  https://huggingface.co/docs/transformers.js · https://www.npmjs.com/package/@xenova/transformers
- Models (ONNX, small, headless): `Xenova/all-MiniLM-L6-v2` (384d, default all-rounder),
  `Xenova/bge-small-en-v1.5` (384d), `nomic-ai/nomic-embed-text-v1.5` (768d).
- Headless controls: set a local model cache dir (`env.localModelPath`) and disable Hub fetches
  (`env.allowRemoteModels = false`) so a sealed/offline install never phones home.
- **Graceful degradation to lexical-only:** treat embeddings as an optional capability. At init,
  probe for onnxruntime-node + a present model file; if missing / download disabled / load throws,
  set `embeddingsAvailable=false` and run Orama in pure-BM25 (or BM25+TF-IDF hybrid) mode. When
  available, switch ranking to RRF(BM25, cosine). Same public search API either way — the tier is
  an internal detail. This mirrors StackOne's "lexical under 2k tools, embeddings only when scaling"
  guidance, so lexical-only is a legitimate default, not a broken state.

### 4c. Projection language for result-filtering (trimming JSON tool results)
- **JMESPath** (`jmespath`, or maintained fork `@jmespath-community/jmespath`) — **pure JS**,
  complete formal spec (consistent across langs), strong list/object **projections**, multiselect
  to reshape output, `|` piping, built-in functions (sort/join/sum). Best fit for *shrinking and
  reshaping* a large tool result down to the fields the agent needs. **Recommended.**
- **jq** via `node-jq` — most expressive language, but the Node package **shells out to the jq
  binary** → native dependency, process-spawn latency, packaging pain in a sealed embed. Avoid as
  the default; consider only if users demand jq syntax.
- **JSONPath** (`jsonpath-plus`) — good for *selecting* nodes (wildcards, recursive descent,
  slices) but **no formal standard** (impl drift) and weak at transformation/reshaping. Fine as a
  lightweight selector, not as the primary projection layer.
Recommendation: **JMESPath as the result-projection language** (pure-JS, spec'd, projection-first,
safe to run on untrusted server output); expose the compiled expression per-tool so the agent (or
config) can declare "keep only these fields." Do not take a jq-binary dependency.
Refs: ritza.co jq-vs-jsonpath-vs-jmespath; jsoneditoronline.org 10-best-json-query-languages.

---

## 5. JS sandbox options for the code-exec phase

Source anchors: Simon Willison "JavaScript Sandboxing Research" (2026-03-22)
https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/ ;
"node:vm is not a sandbox" https://dev.to/dendrite_soup/nodevm-is-not-a-sandbox-stop-using-it-like-one-2f74 ;
vm2 → isolated-vm migration https://github.com/patriksimek/vm2/wiki/vm2-vs-isolated-vm

| Option | Isolation strength | Setup cost | Headless-friendly | Notes |
|---|---|---|---|---|
| `node:vm` | **None** (not a security boundary) — shares process/prototypes; trivially escapable | Lowest | Yes | Never use for model-generated/untrusted code |
| `vm2` | Deprecated (unpatched escapes) | Low | Yes | Dead — do not adopt |
| `worker_threads` | Separate thread + own V8, isolated memory; but **not a hardened security boundary** alone | Low-med | Yes | Good for CPU isolation + timeouts; pair with restricted globals |
| **isolated-vm** | Real V8 isolates: separate heap, no shared prototypes, separate thread, memory/CPU limits. The successor vm2 pointed users to. | Medium — **native addon build** | Mostly (needs prebuilt/native compile) | Strong in-process isolation; still a V8-bug attack surface |
| **QuickJS-WASM** (`quickjs-emscripten`) | Interpreter inside WASM; **capability-based** — host injects only allowed fns (no fs/net unless granted); host V8 bugs don't yield escape | Medium | **Excellent** — pure npm/WASM, no native build | Slower than V8; ideal for small orchestration code |
| Subprocess / container | Strongest (OS/kernel boundary) | High (infra, cold start) | Depends | Overkill for an embedded SDK; leave to host |

**Recommendation:** default to **QuickJS-WASM (`quickjs-emscripten`)** for the code-exec phase.
Rationale for an *embedded, headless* SDK: pure-WASM (no native compile / no prebuild matrix),
capability-based deny-by-default (the agent's generated TS can only call the MCP tool functions and
projection helpers we inject — no ambient fs/net), and V8-level bugs don't escape. The orchestration
code here is small (call a few tools, filter results), so QuickJS's interpreter speed is not the
bottleneck. Offer **isolated-vm as an opt-in "fast tier"** when a host needs near-native perf and
can build native addons, and use **worker_threads** to wrap either engine for hard wall-clock
timeouts + memory caps. Explicitly forbid `node:vm`/`vm2` for untrusted code in the design.

---

## Recommendations block (feeds search / filter / sandbox tickets)

- **Definition-bloat:** implement progressive disclosure — a 3-verb facade (`searchTools` /
  `getToolDefinition` / `callTool`) over all MCP servers; load a tool schema only on demand. Mirrors
  Anthropic Tool Search + AIRIS meta-tool facade.
- **Search ticket:** use **Orama** as the ranking substrate. Ship **lexical/hybrid BM25+TF-IDF as
  the always-on default** (zero-API, <1ms, good to ~2k tools). Add **local embeddings via
  Transformers.js** (`Xenova/all-MiniLM-L6-v2`, `allowRemoteModels=false`, local cache) as an
  **optional tier**; fuse via RRF when present. **Degrade gracefully to lexical-only** when the
  model/onnxruntime is absent — same search API, internal capability flag.
- **Filter ticket (result-bloat, the underserved gap):** attach a **JMESPath** projection to each
  tool (pure-JS `@jmespath-community/jmespath`); trim/reshape large JSON results before they reach
  context. No jq-binary dependency. This is the piece almost no existing gateway does.
- **Sandbox ticket:** run the code-exec orchestration in **QuickJS-WASM (`quickjs-emscripten`)**,
  capability-injected (only MCP tool fns + JMESPath helper exposed), wrapped in a `worker_thread`
  for timeout/memory limits. Provide **isolated-vm** as an opt-in perf tier. Ban `node:vm`/`vm2`.
- **Positioning:** the differentiator is combining on-demand schema loading + code-exec
  orchestration + JMESPath result-trimming in one embeddable TS lib — existing gateways cover
  aggregation/security but not tool-result bloat.

## Sources
- Anthropic, Code execution with MCP (2025-11-04): https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, Advanced tool use (2025-11-24): https://www.anthropic.com/engineering/advanced-tool-use
- StackOne, BM25/TF-IDF/hybrid tool discovery: https://www.stackone.com/blog/mcp-tool-search-bm25-tfidf-hybrid/
- HasMCP, dynamic tool discovery: https://hasmcp.substack.com/p/prevent-mcp-context-bloating-with
- Speakeasy, designing RAG tools: https://www.speakeasy.com/mcp/tool-design/designing-rag-tools-for-llms
- WRITER, too many tools become too much context: https://writer.com/engineering/rag-mcp/
- awesome-mcp-gateways: https://github.com/e2b-dev/awesome-mcp-gateways
- ChatForest gateway/proxy patterns: https://chatforest.com/reviews/mcp-proxy-router-aggregator-servers/
- Orama: https://github.com/oramasearch/orama · https://www.npmjs.com/package/@orama/orama
- Transformers.js: https://huggingface.co/docs/transformers.js · https://www.npmjs.com/package/@xenova/transformers
- JSON query language comparison: https://ritza.co/articles/gen-articles/jq-vs-yq-vs-jsonpath-vs-jmespath-vs-sed-vs-awk/ · https://jsoneditoronline.org/indepth/query/10-best-json-query-languages/
- Simon Willison, JS sandboxing research (2026-03-22): https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/
- node:vm is not a sandbox: https://dev.to/dendrite_soup/nodevm-is-not-a-sandbox-stop-using-it-like-one-2f74
- vm2 vs isolated-vm: https://github.com/patriksimek/vm2/wiki/vm2-vs-isolated-vm
