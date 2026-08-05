# API reference

```ts
import { Winnow } from "mcp-winnow";
```

`Winnow` is the SDK client. (It was formerly `McpClient` — that name is still exported as an alias.)

## Construction

### `new Winnow(options: McpClientOptions)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `upstreams` | `UpstreamConnection[]` | — (required) | The servers to aggregate. Use `StdioUpstream` / `HttpUpstream` / `MockUpstream`, or build from config with `Winnow.fromConfig`. |
| `embedder` | `Embedder` | — | Provide to enable hybrid (semantic) search. Absent → lexical-only. Use `localEmbedder()` for a worker-thread local model (see [USAGE.md](USAGE.md#search--headless-embeddings)). |
| `tokenCounter` | `(text: string) => number` | ~chars/4 | Inject a real tokenizer for exact caps. |
| `defaultMaxTokens` | `number` | `2000` | Global hard cap on any single result (F1). |
| `topK` | `number` | `8` | Default number of search hits. |
| `policies` | `Record<string, ResultFilterPolicy>` | — | Static per-tool filters, keyed by `server:tool` id. |
| `cache` | `boolean` | `true` | Persist the catalog to disk. |
| `cacheDir` | `string` | `~/.cache/winnow` | Cache location. |
| `cacheTtlMs` | `number` | `3600000` | Re-list a cached server older than this. |
| `watch` | `boolean` | `false` | Keep connections live and auto-refresh on `tools/list_changed`. |

### `Winnow.fromConfig(config, extra?)` → `Winnow`

Builds a client from a [config object](CONFIG.md) (validates, interpolates `${ENV}`, constructs upstreams). `extra` accepts any `McpClientOptions` except `upstreams`/`policies` (e.g. `{ embedder, watch }`).

## Lifecycle

### `init()` → `Promise<{ tools, hybrid, skipped, fromCache, watching }>`

Builds the catalog + search index. Call before anything else. On a fresh cache hit it makes **zero upstream connections**.

- `tools` — total tools indexed
- `hybrid` — whether semantic search is active
- `skipped` — servers that failed to list (and had no cache to fall back to)
- `fromCache` — servers served from the disk cache (not connected)
- `watching` — servers with a live `list_changed` subscription (only if `watch: true`)

### `close()` → `Promise<void>`

Unsubscribes watchers and closes all upstream connections.

## The core flow: search → load → call

### `searchTools(query, opts?)` → `Promise<SearchHit[]>`

Ranked, minimal entries (`{ id, name, summary, server, score }`). `opts.topK` overrides the default. A low top `score` is the cue to `listTools` and browse instead of guessing.

### `loadTool(ids)` → `ToolDef[]`

Full schema(s) for one id or an array of ids. This is the only per-tool heavy payload — load only what you'll call.

### `call(id, args, opts?)` → `Promise<FilteredResult>`

Call one tool by `server:tool` id. `opts`:

- `project?: string` — a [JMESPath](USAGE.md#result-filtering-jmespath) expression to reshape/trim the result.
- `maxTokens?: number` — lower the cap for this call (can only lower, never raise).

Returns `{ output, tokens, truncated, note?, isError? }`.

### `listTools(server?)` → `CatalogEntry[]`

Browse all tools (optionally for one server) — the low-confidence escape hatch.

## Composition

### `exec(code, opts?)` → `Promise<FilteredResult>`

Run TypeScript in a sandbox against a generated `mcp.<server>.<tool>(args)` facade — compose many calls and return only a small computed value. Intermediate calls are **not** capped (they never reach context); only the final return is.

```ts
const res = await client.exec(`
  const prs = await mcp.github.listPullRequests({ state: "open" });
  return prs.filter(p => (p.requested_reviewers || []).length === 0).map(p => p.title);
`);
```

`opts`: `timeoutMs?` (default 5000), `memoryMb?` (default 64), `maxTokens?`.

## Freshness

### `refresh(server?)` → `Promise<void>`

Re-list a server (or all), patch the catalog + index, rewrite the cache, and fire `toolsChanged`.

### `on("toolsChanged", cb)`

Register a callback fired whenever the catalog changes (via `refresh` or a watched `list_changed`).

### `listServers()` → `Array<{ server }>`

The connected server names.

## Agent integration: the 4 meta-tools

To expose Winnow to a model's tool list as **four** tools instead of hundreds:

```ts
import { META_TOOLS, dispatchMetaTool } from "mcp-winnow";

// META_TOOLS: [search_tools, load_tool, call_tool, run_code] — put these in the model's tool list.
// When the model calls one, route it:
const result = await dispatchMetaTool(client, toolName, toolArgs);
```

Or run Winnow as a standalone MCP **gateway** so any host gets the 4 tools with no code — see [USAGE.md](USAGE.md#the-gateway).

## Types

```ts
interface ToolDef        { id; server; name; description; inputSchema; outputSchema?; aliases? }
interface CatalogEntry   { id; name; summary; server }
interface SearchHit      extends CatalogEntry { score /* 0-1 */ }
interface FilteredResult { output; tokens; truncated; note?; isError? }
interface CallOpts       { project?; maxTokens? }
interface ResultFilterPolicy { project?; maxTokens?; truncate?; paginate? }
interface Embedder       { embed(texts: string[]): Promise<number[][]> }
```

## Upstreams & auth (lower-level)

```ts
import { StdioUpstream, HttpUpstream, MockUpstream,
         staticBearer, preProvisionedOAuth, clientCredentials } from "mcp-winnow";

new StdioUpstream("github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {...} });
new HttpUpstream("api", { url: "https://.../mcp", getBearer: clientCredentials({ clientId, clientSecret, tokenUrl }) });
```

## Gateway

```ts
import { createGateway, serveStdio, serveHttp } from "mcp-winnow";

await serveStdio(client);                          // local hosts (Claude Desktop, Cursor, plugin)
await serveHttp(client, { port: 8080, token });    // remote/hosted (Streamable HTTP + bearer)
```

See also: [USAGE.md](USAGE.md) for task recipes, [CONFIG.md](CONFIG.md) for the config schema.
