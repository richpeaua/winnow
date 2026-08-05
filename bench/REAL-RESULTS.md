# Winnow — real-server benchmark

Actual MCP servers over stdio (no mocks). Tokens via `gpt-tokenizer` (BPE). Node v24.18.0, 10 cores.

## A. Context reduction (real servers: server-everything + server-filesystem)

Aggregated **27 real tools** over stdio.

### A1. Tool-definition bloat (what the model holds at rest)

| Approach | Tokens | vs baseline |
|---|--:|--:|
| Traditional MCP: all 27 full schemas in context | 2696 | — |
| Winnow: 4 meta-tools only | 259 | **90.4%** smaller |
| Winnow: 4 meta-tools + 1 loaded schema (per task) | 359 | **86.7%** smaller |

Progressive disclosure: the model sees 4 tools; it searches, then loads only the schema it needs.

### A2. Tool-result bloat (real results, trimmed before they hit context)

| Real call | Raw tokens | Winnow | Reduction | How |
|---|--:|--:|--:|---|
| `fs:read_text_file` | 1987 | 786 | **60.4%** | `maxTokens: 800` cap |
| `everything:get-env` | 944 | 187 | **80.2%** | `maxTokens: 200` cap |
| `everything:get-structured-content` | 14 | 10 | **28.6%** | project `{temp, cond}` |

The **cap** is the universal guard — it works on any result (many servers return their payload as a text block of stringified JSON, which can't be projected into). A JMESPath **project** trims further when a server emits real `structuredContent` (as `get-structured-content` does). A forgotten projection can never leak an unbounded blob: the global cap still applies.

## B. Scaling under concurrency (#4-#7), real stdio round-trips

### B1. Sandbox memory ceiling (#4) — N concurrent `run_code`, each doing a real MCP call

| Concurrent run_code | arrayBuffers | rss |
|--:|--:|--:|
| 1 | 34 MB | 135 MB |
| 5 | 128 MB | 170 MB |
| 10 | 128 MB | 171 MB |
| 20 | 128 MB | 171 MB |

Flat at ~128 MB (default `maxWorkers: 4` × 32 MB SAB) regardless of concurrency — vs unbounded per-exec spawn (~32 MB each). Baseline arrayBuffers 2 MB.

### B2. Upstream connection pooling (#7) — concurrent calls to a slow tool

6 concurrent `trigger-long-running-operation(1s)` calls:

| Config | Wall-clock | Serial would be | Parallel would be |
|---|--:|--:|--:|
| single connection (`poolSize: 1`) | 1005 ms | 6000 ms | 1000 ms |
| pooled (`poolSize: 4`) | 1862 ms | 6000 ms | 1000 ms |

**Honest finding:** `server-everything` is async — one subprocess already services 6 concurrent JSON-RPC calls in parallel (~1000 ms, not 6000 ms). So a single connection is **not** the bottleneck, and pooling adds no throughput here (and costs extra subprocess-startup on first use). Pooling (`poolSize > 1`) helps only genuinely **serial** upstreams — one that holds a global lock or does blocking/CPU-bound work per request, where a single connection would serialize the fleet (verified in `test/upstream-pool.test.ts`). For typical async Node MCP servers, keep the default `poolSize: 1`.

