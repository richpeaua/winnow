# Winnow

> Keep the grain, drop the bloat.

**Winnow** (`mcp-winnow`) is an embedded TypeScript SDK that lets an agent use many MCP servers **without context bloat** — it winnows away both tool-definition bloat and tool-result bloat, and works the same attended or headless.

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
import { Winnow } from "mcp-winnow";

const client = new Winnow({ upstreams: [/* your MCP server connections */] });
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
| Public `Winnow` facade + 4 meta-tool adapter (A2) | ✅ implemented |
| Pluggable upstream + in-memory mock | ✅ implemented |
| Real stdio transport (`buildUpstreams`) | ✅ implemented — verified against the reference `server-everything` (see `examples/real-stdio.ts`) |
| Real Streamable-HTTP transport + bearer auth | ✅ implemented + verified live against a local server, incl. 401 on bad token (`examples/real-http.ts`) |
| `Winnow.fromConfig()` | ✅ implemented |
| Code-exec sandbox: sync QuickJS-WASM in a worker + Atomics bridge (X1) | ✅ implemented — `npx tsx examples/exec-demo.ts` (30 fat PRs → 117 tok, 74×) |
| Persistent catalog cache: disk-keyed by upstream identity, zero-connection warm start, `refresh()` (P1) | ✅ implemented (`cache`/`cacheDir`/`cacheTtlMs`; default on) |
| Gateway: run Winnow as an MCP server, stdio + HTTP (P4) | ✅ implemented — `npx tsx examples/gateway-demo.ts` (host → gateway → real upstream) |
| Packaged for publish: `dist` build, types, `mcp-winnow` bin (P3) | ✅ `npm run build`; verified via `npm pack` → clean install → bin runs |

Every part of the spec is implemented, plus the gateway that makes it installable into any MCP host, packaged so `npx -y mcp-winnow` works.

## Install into any MCP host (gateway)

Winnow can run as an MCP **server** exposing just the 4 meta-tools — so a host connects to ONE server and sees FOUR tools while Winnow hides N upstream servers behind search/load/call/run_code. `run_code` runs server-side in Winnow's sandbox, so hosts that can't `import` TS still get the full composition win.

```jsonc
// e.g. claude_desktop_config.json / .cursor/mcp.json
"mcpServers": {
  "winnow": { "command": "npx", "args": ["-y", "mcp-winnow", "gateway", "--config", "winnow.config.json"] }
}
```

`winnow.config.json` lists the upstream servers to aggregate (same schema as `Winnow.fromConfig`). Remote/hosted instead: `serveHttp(winnow, { port, token })` (Streamable-HTTP + bearer). Build the bin with `npm run build`; from source run `npx tsx src/gateway/cli.ts --config winnow.config.json`.

### Claude Code plugin

Winnow also ships as a Claude Code plugin (`plugin/`, listed in `.claude-plugin/marketplace.json`):

```
/plugin marketplace add richpeaua/winnow
/plugin install winnow@winnow
```

Then drop a `winnow.config.json` in your project root. (Requires `mcp-winnow` published to npm, or a local `npm link` — see `plugin/README.md`.)

## Layout

```
src/        SDK: client, catalog, search, filter, config, adapter, sandbox(stub), upstream/
examples/   runnable demo + mock servers
test/       unit + integration tests
bench/      validation benchmarks (token reduction + search recall)
docs/       DESIGN.md — the build-ready spec
wayfinder/  the decision map this project was designed through
```
