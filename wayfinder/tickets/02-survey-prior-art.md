---
id: R2
title: Survey prior art for MCP context-bloat solutions
type: research
labels: [wayfinder:ticket, wayfinder:research]
status: closed
assignee: research-subagent
blocked_by: []
map: map.md
---
## Question

What has already been tried for MCP context bloat, and what should we borrow or avoid? Cover:
- Anthropic's "code execution with MCP" / progressive-disclosure guidance — the pattern, its claimed token savings, its trade-offs.
- Existing tool-search / RAG-over-tools / dynamic-tool-loading approaches (incl. this harness's own ToolSearch pattern) — how they rank and load tools.
- Existing MCP gateways/proxies/routers (open source) — what they do about def-bloat and result-bloat, and where they fall short.
- **TS-usable building blocks:** BM25/lexical libs, local embedding options that run headless with no API (and graceful no-model degradation), projection languages (JMESPath vs jq vs JSONPath) for result-filter.
- Sandbox options for the code-exec phase: `node:vm`, `isolated-vm`, `worker_threads`, subprocess, WASM/QuickJS — security vs ergonomics.

Deliver a findings doc (link from this ticket) with concrete, sourced recommendations feeding the search, filter, and sandbox tickets.

## Resolution

Findings: [research/R2-prior-art-findings.md](../research/R2-prior-art-findings.md).
- **Prior art:** Anthropic "Code execution with MCP" (2025-11-04, 150k→2k = 98.7%); productized as Tool Search Tool (~85% def savings) + Programmatic Tool Calling (37%) in "Advanced tool use" (2025-11-24). Existing gateways (ContextForge, MetaMCP, AIRIS, MCPProxy, AgentGateway) tackle def-bloat partially; **tool-result bloat essentially unaddressed = our differentiator.**
- **Search:** Orama (TS, zero-dep, BM25 + native hybrid) as always-on lexical default; local embeddings via Transformers.js (`Xenova/all-MiniLM-L6-v2` 384d, `allowRemoteModels=false`), fused with RRF; graceful **lexical-only fallback** via capability probe. (StackOne: BM25 14% < TF-IDF 20.8% < hybrid 21.2% < embeddings 38% Top-1.)
- **Result-filter:** JMESPath (`@jmespath-community/jmespath`, pure JS) per-tool projections; avoid jq/node-jq (shells out); JSONPath weak at reshaping.
- **Sandbox:** QuickJS-WASM (`quickjs-emscripten`) default — capability-injected, pure-WASM, V8 escapes contained; wrap in `worker_threads` for timeout/memory; `isolated-vm` opt-in perf tier; ban `node:vm`/`vm2`.
