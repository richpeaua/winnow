---
id: R2
title: Survey prior art for MCP context-bloat solutions
type: research
labels: [wayfinder:ticket, wayfinder:research]
status: open
assignee:
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
