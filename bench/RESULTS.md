# Validation results — mcp-client design

Run: `cd bench && npm install && node bench.js`. Fixed, repeatable.

## Numbers (gpt-tokenizer cl100k proxy)

| Metric | Naive | mcp-client | Reduction |
|---|---|---|---|
| **Definitions at rest** (52 tools) | 3,787 tok | 388 tok (4 meta-tools) | **89.8% / 9.8×** |
| **Fat call** github:list_pull_requests (30 PRs) | 22,372 tok | 1,772 (call-path) / 272 (exec-path) | **12.6× / 82×** |
| **End-to-end task** | 26,194 tok | 2,742 (call) / 1,007 (exec) | **9.6× / 26×** |

Spec targets: defs ≥85% ✅, result ≤2k cap ✅, end-to-end ~10× ✅ (9.6× call-path, 26× exec-path).

## Verdict

The design's headline claims are **validated on a representative surface**. The result-filter (the differentiator) carries the largest single win. Proceeding to build is justified.

## Honest caveats (numbers move with these)

1. **Tokenizer is a proxy** — gpt-tokenizer (GPT-4 cl100k), not Claude's tokenizer. Absolute counts differ ~10-20%; the *reduction ratios* are stable across tokenizers, and ratios are the claim.
2. **Surface is fixtures, not live servers** — 52 realistic tools (came out at 52, not the ~80 the M1 scenario named; more tools only *increases* the def-bloat advantage, so this is conservative). Schemas and the GitHub PR payload are realistically shaped, not tuned to flatter the SDK.
3. **End-to-end ratio is task-shaped** — this task has one fat call that dominates; tasks with many small calls reduce less on results but more on defs. 9.6× is one honest point, not a universal constant.
4. **Search *cost* modeled, search *quality* not** — the benchmark counts what top-8 entries cost in context; it does not test whether ranking surfaces the right tool (that is S1 recall, a separate validation — worth a follow-up before build if def-bloat savings depend on the agent not falling back to listing everything).
5. **Exec-path assumes the agent writes good reducing code** — 26× is the ceiling when it filters in-sandbox; a naive agent that returns everything lands nearer the call-path 9.6×.

## Follow-up worth doing before/with build
- Validate **search recall** on the 52-tool surface (does hybrid/lexical find the right tool from a natural-language query?) — the one unmeasured link in the def-bloat chain.
