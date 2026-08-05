---
id: M1
title: Define the bloat-reduction success metric & token accounting
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
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

## Resolution

**Baseline (what we beat):** the naive path — connect all configured servers, inject every tool's full schema into the model's tool list, and return every tool result raw.

**Token counting:** the target model's real tokenizer (Anthropic count-tokens API for the Claude case; a tokenizer lib otherwise), so numbers reflect actual context cost, not char counts.

**The four metrics:**
1. **Definitions-at-rest** — tokens for the tool surface before any work. Baseline = all full schemas; SDK = the 4 meta-tools + N minimal catalog entries kept internal (the model sees ~4 tools). **Target: ≥ 85% reduction** (aligns with R2's Tool Search Tool result).
2. **Per-search cost** — tokens a `searchTools` call adds (top-k × ~20-40 tok entry). Bounded and small by construction (C1/S1).
3. **Per-call result** — raw vs F1-filtered tokens. **Target: every result ≤ the configured cap** (default ~2k tok), vs unbounded baseline.
4. **End-to-end task** — total context tokens to complete the reference task. **Target: ≥ ~10× reduction** vs baseline on the benchmark.

**Reference benchmark (fixed, repeatable):** ~5 servers / ~80 tools total (e.g. github, slack, filesystem, postgres, web-search), running one realistic multi-tool task: *"find open PRs with no review in 7 days and post a one-line summary of each to a Slack channel."* Measured attended (hybrid search) and headless (lexical-only) to prove the degradation path doesn't crater accuracy.

**Accepted costs (named, not hidden):** small search latency (BM25 <1ms; embedding add when active); a recall risk in lexical-only mode (mitigated by RRF when a model is present); codegen time on first `exec` per server. These are the trade for the reductions above and are logged so the benchmark stays honest (map's "no silent caps" spirit).
