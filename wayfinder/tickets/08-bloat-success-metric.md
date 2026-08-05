---
id: M1
title: Define the bloat-reduction success metric & token accounting
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

How do we prove the SDK actually cuts context bloat — the yardstick the whole spec is judged against?
- The baseline: naive "connect all servers, dump all tool defs + raw results" token count vs the SDK path.
- What we measure: tokens for tool-definitions at rest, per-search cost, per-call result tokens (raw vs filtered), and end-to-end tokens for a representative task.
- A small fixed scenario/benchmark (a few servers, a realistic multi-tool task) to make before/after numbers comparable and repeatable.
- Success thresholds worth committing to in the spec (e.g. target % reduction), and any accuracy/latency cost we accept for it.

Output: the metric definitions + a reference benchmark scenario. Mostly independent of the other tickets.
