---
id: Z1
title: Assemble the build-ready design spec
type: task
labels: [wayfinder:ticket, wayfinder:task]
status: open
assignee:
blocked_by: [R1, R2, C1, S1, F1, G1, X1, M1]
map: map.md
---
## Question

Stitch every resolved decision into one coherent, build-ready design spec + decision log — the map's destination. Not a fresh decision; a synthesis that must hang together:
- Assemble: architecture overview, the catalog/disclosure model (C1), search (S1), result-filter (F1), config/secrets (G1), code-exec sandbox (X1), plus the fog that graduated (codegen API, public `McpClient` API surface, attended/headless behavior).
- Check cross-consistency: the API surface actually exposes search/filter/exec coherently; headless holds throughout; success metric (M1) is achievable by the design.
- Include the decision log (why, not just what) and open risks.

This ticket comes last. Terminal — nothing blocks on it. Expect newly-graduated fog tickets to be added to its `blocked_by` before it is worked.
