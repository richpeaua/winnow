---
id: A2
title: Design the public McpClient API surface
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: [C1, S1, F1, X1, A1]
map: map.md
---
## Question

(Graduated from the "Public McpClient API surface" fog once the core mechanisms resolved — it is their integration point.)
What are the actual class/method signatures a host agent imports and drives?

## Resolution

**The class — the 3-verb disclosure facade plus exec and lifecycle:**
```ts
class McpClient {
  constructor(config: McpClientConfig)
  init(): Promise<void>                 // build catalog+index, or load fresh cache (C1)

  searchTools(query: string, opts?: { topK?: number }): SearchHit[]   // S1 — {id,name,summary,server,score}
  loadTool(id: string | string[]): ToolDef[]                          // C1 — full schema(s), on demand
  call(id: string, args: object, opts?: CallOpts): FilteredResult     // F1 — one tool
  exec(code: string, opts?: ExecOpts): FilteredResult                 // X1 — composed, sandboxed

  listServers(): ServerInfo[]
  on(event: 'toolsChanged', cb): void   // C1 list_changed
  close(): Promise<void>
}
// CallOpts  = { project?: string /*JMESPath*/, maxTokens?: number }
// ExecOpts  = { timeoutMs?, memoryMb? }
```

**Two ways a host consumes it:**
1. **Direct SDK** — the app calls the methods from its own agent loop (typed, in-process; the primary target).
2. **Meta-tool adapter** — the SDK ships an adapter that surfaces exactly four meta-tools to a model: `search_tools`, `load_tool`, `call_tool`, `run_code`. This is the def-bloat payoff at the *model* layer: the model's tool list holds **~4 tools instead of hundreds**, mirroring the harness's own ToolSearch pattern (R2). The later thin-gateway adapter (fog) wraps this same surface over MCP for hosts you don't own.

**Why this is the coherent integration point:** every anti-bloat mechanism is exposed once and only once — `searchTools`+`loadTool` for def-bloat, `call`/`exec` with `project`/`maxTokens` for result-bloat — and both consumption modes reduce to these methods.
