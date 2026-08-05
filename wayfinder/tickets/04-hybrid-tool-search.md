---
id: S1
title: Design the hybrid lexical + semantic tool-search
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: [R2]
map: map.md
---
## Question

How does `searchTools(query)` rank across N servers' tools, and how does it degrade headless?
- Lexical component (BM25 over what fields — name, description, server, param names?) and semantic component (which embedding source; is it optional?).
- Fusion: how lexical and semantic scores combine (weighting / reciprocal-rank fusion), and the result shape returned to the agent (top-k catalog entries).
- **Headless / no-model degradation:** what happens when no embedding backend is configured — lexical-only fallback, and is that acceptable? This is a hard requirement from the map.
- Index build & refresh cost; where the index lives; incremental updates when the catalog changes.

Output: the ranking design + the degradation contract.

## Resolution

**Components (from R2):** Orama (BM25 + native hybrid, zero-dep) for lexical; Transformers.js local embeddings (`Xenova/all-MiniLM-L6-v2`, 384d) for semantic; **Reciprocal Rank Fusion (RRF)** to combine the two ranked lists.

**Posture — auto-detect, hybrid-if-cached** *(user choice)*: at init, capability-probe for a usable embedding model (already present/cached, `allowRemoteModels=false`). Found → hybrid (RRF over BM25 + vector). Absent → lexical-only BM25. **Never auto-downloads** — a headless run with no model silently runs lexical-only. This satisfies the map's hard degradation requirement.

**Backend — pluggable:** an `Embedder` interface (`embed(texts): number[][]`). Default `LocalMiniLM` (zero-API). A user may inject a remote embedder (Voyage/OpenAI) for higher recall — doing so is what makes the probe "find" a model. Local presence is never required.

**Indexed fields & weighting:** index name + title + description + parameter descriptions + server (per R1); boost order name/title > description > param-descriptions. `annotations` excluded (untrusted, per R1).

**Result shape:** `searchTools(query)` returns top-k (default 8, configurable) minimal entries `{id,name,summary,server}` **plus a normalized `score` (0-1)** so the agent can gauge confidence and choose loadTool vs re-search — cutting wasted schema loads, themselves a bloat source. Never returns full schemas (that would defeat def-bloat).

**Index lifecycle:** built and persisted with the C1 catalog (cache default-on); patched incrementally on `list_changed`. Lexical index always built; vector index only when an embedder is active.
