# Usage guide

Task-oriented recipes. See [API.md](API.md) for the full reference and [CONFIG.md](CONFIG.md) for the config schema.

- [Install](#install)
- [Quickstart: search → load → call](#quickstart-search--load--call)
- [Connecting servers](#connecting-servers)
- [Result filtering (JMESPath)](#result-filtering-jmespath)
- [Composition with `exec` / `run_code`](#composition-with-exec--run_code)
- [Using Winnow from an agent (the 4 meta-tools)](#using-winnow-from-an-agent-the-4-meta-tools)
- [The gateway](#the-gateway)
- [Search & headless embeddings](#search--headless-embeddings)
- [Cache & live updates](#cache--live-updates)
- [Troubleshooting](#troubleshooting)

## Install

```bash
npm install mcp-winnow
```

Requires Node >= 20. `@huggingface/transformers` (local embeddings) is an optional dependency — without it, search runs lexical-only.

## Quickstart: search → load → call

The whole point: the model never sees every tool schema. It searches, loads only what it needs, then calls — and results are trimmed before they hit context.

```ts
import { Winnow, StdioUpstream } from "mcp-winnow";

const client = new Winnow({
  upstreams: [
    new StdioUpstream("github", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN! },
    }),
  ],
});

await client.init();

const hits = await client.searchTools("list open pull requests"); // minimal entries + score
const [def] = client.loadTool(hits[0].id);                          // full schema, on demand
const res  = await client.call(hits[0].id, { state: "open" }, {
  project: "[].{number: number, title: title, url: html_url}",      // trim before it hits context
});
console.log(res.output);

await client.close();
```

Or build the whole thing from a [config file](CONFIG.md):

```ts
import { Winnow } from "mcp-winnow";
import { readFileSync } from "node:fs";

const client = Winnow.fromConfig(JSON.parse(readFileSync("winnow.config.json", "utf8")));
await client.init();
```

## Connecting servers

### stdio

```ts
new StdioUpstream("fs", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"],
});
```

### HTTP with auth

All auth modes are browserless. Use the ready-made providers:

```ts
import { HttpUpstream, staticBearer, preProvisionedOAuth, clientCredentials } from "mcp-winnow";

// static bearer
new HttpUpstream("api", { url: "https://x/mcp", getBearer: staticBearer(process.env.TOKEN) });

// pre-provisioned OAuth (raw token or JSON token set)
new HttpUpstream("api", { url: "https://x/mcp", getBearer: preProvisionedOAuth(process.env.OAUTH_TOKENS!) });

// OAuth 2.0 client_credentials — fetched + refreshed automatically
new HttpUpstream("api", {
  url: "https://x/mcp",
  getBearer: clientCredentials({
    clientId: process.env.CID!,
    clientSecret: process.env.CSECRET!,
    tokenUrl: "https://issuer/oauth/token",
  }),
});
```

(Via config, you just set `auth: { type: ... }` — see [CONFIG.md](CONFIG.md#auth-http-only).)

## Result filtering (JMESPath)

This is the differentiator: raw tool results (often multi-KB JSON) are trimmed to what you asked for **before** they reach context. Winnow uses [JMESPath](https://jmespath.org). A projection can be set two ways:

- **Static (config)** — per tool, so every call is trimmed by default: `tools: { "list_pull_requests": { "project": "..." } }`.
- **Per call** — `client.call(id, args, { project: "..." })`. Overrides the static projection; the size cap still applies as a hard ceiling.

Common patterns:

```jsonc
// keep a few fields from each item in an array
"[].{number: number, title: title, url: html_url}"

// pull one nested field
"data.items[].name"

// filter, then project
"[?state=='open'].{id: id, title: title}"

// first N (JMESPath slicing)
"items[:20]"
```

If nothing is supplied, the result is returned as-is but still bounded by the global `maxTokens` cap (default 2000) — so a forgotten projection can never leak an unbounded blob. Base64 image/audio blocks are replaced with a small reference stub by default. Check `res.truncated` and `res.note` to know if anything was dropped.

## Composition with `exec` / `run_code`

For multi-tool workflows, `exec` runs code in a sandbox against a typed `mcp.<server>.<tool>()` facade (tool names camelCased). Many calls happen server-side; **only the small return value hits context** (intermediate results are never capped because they never reach the model).

```ts
const res = await client.exec(`
  const prs = await mcp.github.listPullRequests({ state: "open" });
  const stale = prs.filter(p => (p.requested_reviewers || []).length === 0);
  for (const p of stale) {
    await mcp.slack.createMessage({ channel: "eng", text: "#" + p.number + " " + p.title });
  }
  return { posted: stale.length };
`);
```

The sandbox is capability-injected: no `fs`, `net`, `env`, `process`, or timers — only the `mcp.*` facade. It has a wall-clock timeout (`timeoutMs`, default 5s) and memory cap (`memoryMb`, default 64).

## Using Winnow from an agent (the 4 meta-tools)

Give the model **four** tools instead of hundreds:

```ts
import { META_TOOLS, dispatchMetaTool } from "mcp-winnow";

// 1. Put META_TOOLS (search_tools, load_tool, call_tool, run_code) in the model's tool list.
// 2. When the model calls one, dispatch it:
const output = await dispatchMetaTool(client, call.name, call.args);
```

The model's loop becomes: `search_tools("...")` → `load_tool([...])` → `call_tool(id, args, project?)` (or `run_code(...)` for composition).

## The gateway

To make Winnow installable into any MCP host with no code, run it as an MCP **server** exposing the same 4 meta-tools.

```ts
import { Winnow, serveStdio, serveHttp } from "mcp-winnow";

const client = Winnow.fromConfig(config);
await client.init();

await serveStdio(client);                            // local hosts
// or, remote/hosted:
await serveHttp(client, { port: 8080, token: process.env.GATEWAY_TOKEN });
```

From the CLI (after `npm run build`, or once published via `npx`):

```bash
mcp-winnow gateway --config winnow.config.json            # stdio
mcp-winnow gateway --config winnow.config.json --http --port 8080   # http (bearer via WINNOW_GATEWAY_TOKEN)
```

A host then connects to one server and sees four tools. `run_code` runs server-side in Winnow's sandbox, so even hosts that can't import TypeScript get full composition. See the [Claude Code plugin](../plugin/README.md) for the marketplace install.

## Search & headless embeddings

Search is hybrid: BM25 (always on) fused with semantic embeddings **when a model is available**.

- **Lexical-only (default headless):** works with zero setup, ~88% recall@8. Add per-tool `aliases` in the tool definitions to lift recall on paraphrased queries.
- **Hybrid (100% recall@8):** pass an `embedder`. A local one (Transformers.js) runs with no API; for headless, **pre-cache the model** rather than relying on a download.

```ts
import { Winnow } from "mcp-winnow";
const client = new Winnow({ upstreams, embedder: myEmbedder });
```

An `Embedder` is just `{ embed(texts: string[]): Promise<number[][]> }` — plug in any local or hosted model.

## Cache & live updates

- **Disk cache (on by default):** the catalog is cached under `~/.cache/winnow`, keyed by each server's identity. A second process reuses it and makes **zero connections** until a tool is called. Disable with `cache: false`; tune with `cacheDir` / `cacheTtlMs`.
- **Manual refresh:** `await client.refresh("github")` re-lists a server and fires `toolsChanged`.
- **Live watch (opt-in):** `new Winnow({ upstreams, watch: true })` keeps connections open and auto-refreshes when a server emits `tools/list_changed`.

```ts
client.on("toolsChanged", () => console.log("catalog updated"));
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `call init() before using the client` | Call `await client.init()` first. |
| A server is missing from search | Check `init()`'s `skipped` — it failed to list. Verify the command/URL/auth. |
| Search misses a tool | You're likely lexical-only; add tool `aliases`, or pass an `embedder` for hybrid. Use `client.listTools(server)` to browse. |
| Results still large | Add a `project` (config or per call) and/or lower `maxTokens`. Check `res.truncated`. |
| Stale tools after a server changed | `await client.refresh()` or run with `watch: true`. |
| `unknown tool id` | Ids are `server:tool` (e.g. `github:list_pull_requests`). |
