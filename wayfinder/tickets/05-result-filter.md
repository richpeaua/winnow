---
id: F1
title: Design the deterministic result-filter layer
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

How does a raw tool result get trimmed before it reaches context? Decide (static policy + agent override, per the framing):
- Projection language for both config policy and agent override — JMESPath vs jq vs JSONPath (feed from prior-art survey); one language for both.
- The static per-tool policy schema in config: default projection, size caps (bytes/tokens), truncation strategy, pagination/`nextCursor` handling.
- The agent-override API at call time and the precedence rule (override replaces? narrows? is bounded by the cap?).
- Non-JSON / mixed content (text blocks, images, resource links): what filtering even means there, and the safe default.
- Headless safety: the default when the agent supplies nothing must never leak an unbounded result.

Output: the filter config schema + override semantics + defaults.
