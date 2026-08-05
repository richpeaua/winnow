# Configuration reference

Winnow is configured with a plain object (validated with [zod](https://zod.dev), fail-fast). You can pass it two ways:

```ts
import { Winnow } from "mcp-winnow";

// From a config object / file (JSON, YAML you parse, or a TS module):
const client = Winnow.fromConfig(configObject);

// Or construct upstreams yourself (see docs/API.md):
const client = new Winnow({ upstreams: [ /* ... */ ] });
```

The gateway CLI reads a JSON file: `mcp-winnow gateway --config winnow.config.json`.

## Secrets

**Never inline secrets.** Any string value may reference an environment variable with `${VAR}`; it's interpolated at load time, and a missing variable fails fast.

```jsonc
"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
```

## Top-level schema

```jsonc
{
  "servers": { /* required — map of name -> server config (see below) */ },
  "cache": true,                      // default true; false = ephemeral (no disk cache)
  "defaults": { "maxTokens": 2000 },  // global result-filter cap (F1)
  "search":   { "topK": 8 },          // default number of search hits
  "sandbox":  { "maxWorkers": 4 }     // bound run_code concurrency (see below)
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `servers` | `Record<string, ServerConfig>` | — (required) | The upstream MCP servers to aggregate. The key is the server name (the `server` in `server:tool` ids). |
| `cache` | `boolean` | `true` | Persist the catalog to `~/.cache/winnow`. `false` = rebuild every process. |
| `defaults.maxTokens` | `int > 0` | `2000` | Hard ceiling on any single tool result's tokens. An agent can lower it per call but never raise it. |
| `search.topK` | `int > 0` | `8` | How many hits `searchTools` returns by default. |
| `sandbox` | `object` | — | Bound `run_code` concurrency (see [Sandbox pool](#sandbox-pool)). |

## Sandbox pool

`run_code` runs each exec in a worker thread holding a 32 MB SharedArrayBuffer + a QuickJS heap. Under many concurrent execs (e.g. one shared HTTP gateway serving a fleet), a bounded pool caps how many run at once, so **memory is flat regardless of agent count** — `maxWorkers × (32 MB + heap)` — with a queue + backpressure past the cap.

```jsonc
"sandbox": {
  "maxWorkers": 4,        // max concurrent execs; default max(1, min(4, cpus-1))
  "maxQueue": 32,         // queued execs before backpressure rejects; default maxWorkers*8
  "queueTimeoutMs": 10000 // reject an exec that waits longer than this in the queue
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `maxWorkers` | `int > 0` | `max(1, min(4, cpus-1))` | Concurrent sandbox workers. Raise for more parallel `run_code`, at ~(32 MB + heap) each. |
| `maxQueue` | `int > 0` | `maxWorkers * 8` | Execs allowed to wait for a free worker. Past this, `run_code` returns an error result (backpressure) rather than spawning past the cap. |
| `queueTimeoutMs` | `int > 0` | `10000` | An exec queued longer than this fails with a timeout error result. |

Workers are spawned lazily (none until the first `run_code`) and reused across execs; each exec runs in a fresh QuickJS context (no state leaks between execs).

## Server config

A server is either **stdio** or **http** (discriminated by `transport`).

### stdio

```jsonc
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
  "tools": { /* per-tool filter policies, see below */ }
}
```

| Field | Type | Notes |
|---|---|---|
| `transport` | `"stdio"` | required |
| `command` | `string` | required — the executable |
| `args` | `string[]` | optional |
| `env` | `Record<string,string>` | optional — passed to the subprocess (use `${VAR}` for secrets) |
| `tools` | `Record<string, FilterPolicy>` | optional — see [Result-filter policies](#result-filter-policies) |
| `poolSize` | `int > 0` | optional (default 1) — replica connections for fan-in; see [Connection pooling](#connection-pooling) |

### http (Streamable HTTP)

```jsonc
{
  "transport": "http",
  "url": "https://example.com/mcp",
  "headers": { "X-Custom": "value" },
  "auth": { /* see Auth below */ },
  "tools": { /* per-tool filter policies */ }
}
```

| Field | Type | Notes |
|---|---|---|
| `transport` | `"http"` | required |
| `url` | `string` (URL) | required |
| `headers` | `Record<string,string>` | optional static headers |
| `auth` | `AuthConfig` | optional — see below |
| `tools` | `Record<string, FilterPolicy>` | optional |
| `poolSize` | `int > 0` | optional (default 1) — replica connections for fan-in; see [Connection pooling](#connection-pooling) |

## Auth (http only)

All three modes are **browserless** (headless-safe). Interactive OAuth is never required.

```jsonc
// 1. Static bearer token
"auth": { "type": "bearer", "token": "${API_TOKEN}" }

// 2. Pre-provisioned OAuth — a raw access token or a JSON token set
"auth": { "type": "oauth", "tokens": "${OAUTH_ACCESS_TOKEN}" }

// 3. OAuth 2.0 client_credentials grant (fetched + refreshed automatically)
"auth": {
  "type": "client_credentials",
  "clientId": "${CLIENT_ID}",
  "clientSecret": "${CLIENT_SECRET}",
  "tokenUrl": "https://issuer.example.com/oauth/token"
}
```

| `type` | Fields | Behavior |
|---|---|---|
| `bearer` | `token` | Sent as `Authorization: Bearer <token>`. |
| `oauth` | `tokens` | A raw access token, or a JSON `{ "access_token": "..." }`; the access token is used as the bearer. |
| `client_credentials` | `clientId`, `clientSecret`, `tokenUrl` | POSTs the grant, caches the token, refreshes ~30s before expiry, reconnects when it changes. |

## Result-filter policies

Under a server's `tools`, keyed by the tool's short name, you set the static filter applied to that tool's results before they reach context.

```jsonc
"tools": {
  "list_pull_requests": {
    "project": "[].{number: number, title: title, url: html_url}",
    "maxTokens": 1500,
    "truncate": "tail"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `project` | `string` (JMESPath) | Reshape/trim the result. See [USAGE.md](USAGE.md#result-filtering-jmespath). |
| `maxTokens` | `int > 0` | Per-tool cap (still bounded by `defaults.maxTokens`). |
| `truncate` | `"head" \| "tail" \| "smart"` | How to trim when over the cap (arrays drop from the tail today). |
| `paginate` | `boolean` | Reserved for pagination handling. |

An agent can override `project`/`maxTokens` per call, but the cap is a hard ceiling it can only lower.

## Connection pooling

At scale the shape is fan-in: many agents → one shared Winnow → **one** connection per upstream. JSON-RPC multiplexes by id so the client never serializes, but a **single-threaded upstream** (many MCP servers are) processes calls sequentially, so the fleet queues behind one server instance.

Set `poolSize` on a server to keep N replica connections and dispatch each call to the **least-busy** one — giving a single-threaded server N parallel workers:

```jsonc
"github": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "poolSize": 4 }
```

Replicas connect **lazily** and are reused: idle cost stays at one connection; extras spin up only under concurrency. `poolSize: 1` (the default) is the single-connection behavior with zero overhead. Pooling doesn't change the cache key, so raising it never invalidates the catalog cache.

## Multi-tenant auth passthrough (http gateway)

By default every request through the gateway hits each upstream as the **same** configured identity. For a shared gateway serving many agents that must act as **distinct** upstream identities, `gateway.forwardAuth` maps a server to a request header carrying that agent's per-call bearer:

```jsonc
{
  "servers": { "github": { "transport": "http", "url": "https://api.github.com/mcp" } },
  "gateway": {
    "forwardAuth": { "github": "X-Winnow-Github-Auth" }   // serverName -> request header
  }
}
```

Now an agent's request header `X-Winnow-Github-Auth: Bearer <token>` becomes that call's GitHub bearer (a leading `Bearer ` is stripped). A request that omits the header falls back to the server's configured identity. No upstream secrets are baked into the shared config — each agent presents its own.

| Field | Type | Notes |
|---|---|---|
| `gateway.forwardAuth` | `Record<serverName, headerName>` | Forward the named request header as that upstream's per-call bearer. Only meaningful for `--http`. |

For programmatic control (map a JWT subject to credentials, read a vault, etc.), pass `resolveAuth` to `serveHttp` instead — see [API.md](API.md#gateway). Passthrough is strictly opt-in: with neither set, all requests use the configured identity.

## Full example

```jsonc
{
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "tools": {
        "list_pull_requests": { "project": "[].{number: number, title: title, url: html_url}" }
      }
    },
    "internal-api": {
      "transport": "http",
      "url": "https://api.internal.example.com/mcp",
      "auth": { "type": "client_credentials", "clientId": "${CID}", "clientSecret": "${CSECRET}", "tokenUrl": "https://auth.example.com/token" }
    }
  },
  "defaults": { "maxTokens": 2000 },
  "search": { "topK": 8 }
}
```
