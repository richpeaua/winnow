---
id: S1
title: Design the hybrid lexical + semantic tool-search
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
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
