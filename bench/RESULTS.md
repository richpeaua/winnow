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

## Search recall (measured — `node recall.js`)

16 queries (10 hard paraphrases) over the 52-tool surface, real Orama BM25 + real Transformers.js all-MiniLM embeddings + RRF.

| method | recall@1 | recall@3 | recall@8 | MRR |
|---|---|---|---|---|
| lexical (headless floor) | 38% | 63% | **88%** | 0.55 |
| semantic | 56% | 81% | 100% | 0.73 |
| hybrid | 63% | 88% | **100%** | 0.74 |

Hard paraphrases only: lexical recall@8 **80%**, hybrid **100%**.

**Key finding — the headless floor has a hole.** `searchTools` returns top-8, so recall@8 is the operative number. Hybrid nails it (100%). **Lexical-only misses ~12% overall / ~20% of paraphrases** — e.g. *"show me PRs that still need a reviewer"* ranked the right tool **#36**, *"look up a user profile"* #12. On a miss the agent fails or falls back to listing all tools, which **erases the def-bloat win**. So "graceful degradation to lexical-only headless" is a real recall regression, not a free fallback.

**Design refinements this forces (folded into DESIGN.md §4 / §15):**
1. **Pre-provision the embedding model for headless** — it is a one-time ~23MB cache, not a per-run download; treat lexical-only as a true *last-resort* fallback, not the expected headless path.
2. **Add a per-tool `aliases`/keywords field** authors can populate — cheaply lifts lexical recall on paraphrases.
3. **Low-confidence escape hatch** — expose the `score`; when the top hit is weak, the agent can `list_tools(server)` to browse rather than mis-call or give up.

Net: recall@8 is the metric that matters; hybrid delivers 100% and is strongly recommended as the default whenever a model can be cached. Everything else in the design is validated.
