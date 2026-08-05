# mcp-client

An embedded TypeScript SDK that lets an agent use many MCP servers **without context bloat** — it kills both tool-definition bloat and tool-result bloat, and works the same attended or headless.

Full design + decision log: [`docs/DESIGN.md`](docs/DESIGN.md). Validation numbers: [`bench/RESULTS.md`](bench/RESULTS.md).

## The idea

- **Definition bloat** → the model sees ~4 meta-tools (`search_tools`, `load_tool`, `call_tool`, `run_code`) instead of hundreds of full schemas. Full defs stay inside the SDK; the agent searches, loads only what it needs, then calls.
- **Result bloat** → every result is trimmed by a JMESPath projection and a **hard token cap the agent can only lower** — so even a forgotten projection can't leak an unbounded blob.

Measured on a representative surface: **~10× (call) / 26× (exec)** end-to-end token reduction; hybrid search **100% recall@8**.

## Quickstart

```bash
npm install
npm run demo        # end-to-end: search -> loadTool -> call, with token savings
npm test            # core unit + integration tests
npm run typecheck
```

```ts
import { McpClient } from "mcp-client";

const client = new McpClient({ upstreams: [/* your MCP server connections */] });
await client.init();

const hits = await client.searchTools("list open pull requests"); // minimal entries + score
const [def] = client.loadTool(hits[0].id);                          // full schema on demand
const res  = await client.call(hits[0].id, { state: "open" }, {
  project: "[].{number: number, title: title}",                     // trim before it hits context
});
```

## Status

| Area | State |
|---|---|
| Catalog / progressive disclosure (C1) | ✅ implemented |
| Hybrid search: Orama BM25 + optional embedder + RRF (S1) | ✅ implemented |
| Result-filter: JMESPath + hard cap + base64 stubbing (F1) | ✅ implemented |
| Config + `${ENV}` interpolation, zod fail-fast (G1) | ✅ implemented |
| Public `McpClient` facade + 4 meta-tool adapter (A2) | ✅ implemented |
| Pluggable upstream + in-memory mock | ✅ implemented |
| Real stdio transport (`buildUpstreams`) | ✅ implemented — verified against the reference `server-everything` (see `examples/real-stdio.ts`) |
| Real Streamable-HTTP transport + bearer auth | ✅ implemented (not yet live-tested) |
| `McpClient.fromConfig()` | ✅ implemented |
| Code-exec sandbox: QuickJS-WASM (X1) | 🚧 stub (`src/sandbox.ts`) |

The core (search → load → call → filter) is real and drives actual MCP servers over stdio. `npx tsx examples/real-stdio.ts` proves the round-trip. The one remaining stub — the `exec` sandbox — is clearly marked and throws with a pointer to the design.

## Layout

```
src/        SDK: client, catalog, search, filter, config, adapter, sandbox(stub), upstream/
examples/   runnable demo + mock servers
test/       unit + integration tests
bench/      validation benchmarks (token reduction + search recall)
docs/       DESIGN.md — the build-ready spec
wayfinder/  the decision map this project was designed through
```
