---
id: A1
title: Design the generated typed code API
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: [C1, X1]
map: map.md
---
## Question

(Graduated from the "Generated typed code API" fog once the catalog model (C1) and sandbox runtime (X1) resolved.)
What TypeScript API does sandboxed code execute against? Decide the `server → module` codegen: module/function naming, how types come from JSON Schema, how a call is written, and how it bridges to the real client.

## Resolution

**Shape:** one module per server; each tool becomes a typed async function.
```ts
import { github } from 'mcp:github'
const prs = await github.listPullRequests({ state: 'open' })   // typed args + result
```

**Naming:** server name → module id (`mcp:<server>`); tool `list_pull_requests` → camelCase `listPullRequests`. Collisions are impossible across modules (namespaced by server); intra-server duplicates keep the raw name.

**Types (from R1):** input type generated from the tool's `inputSchema` (JSON Schema 2020-12) via a json-schema→TS step; return type from `outputSchema` when present, else a generic `ToolResult`. Types live **in the sandbox only** — they cost zero model context, so full typing is free here (unlike the at-rest catalog entry, which stays minimal).

**Call bridge:** each generated function body calls the injected host capability `__mcpCall(server, tool, args, opts)` (X1). That bridge runs the real MCP call and applies the **F1 result-filter** before returning — so in-sandbox results are already trimmed. The function returns the filtered value for the code to compose.

**Generation timing:** modules are generated from cached schemas (C1); a tool whose schema isn't cached yet is fetched (`loadTool`) on first codegen. Only servers/tools the code imports are materialized — no need to generate all.

**Consistency with `call()`:** `github.listPullRequests(args)` and `call('github:list_pull_requests', args)` hit the same bridge and the same filter policy; `exec` just lets many such calls be composed and reduced before returning.
