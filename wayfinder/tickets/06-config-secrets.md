---
id: G1
title: Design the config & headless-safe secrets format
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: []
map: map.md
---
## Question

How is the SDK configured, with zero interactive prompts so headless works? Decide:
- Config format & source: file (JSON/YAML/TS module) + env overrides. Server declarations (command/args/env for stdio, URL/headers for HTTP).
- Per-server: transport, auth, and the hook to per-tool result-filter policy (F1) and any search tuning (S1).
- **Secrets:** env vars vs token files vs pre-provisioned OAuth tokens — how a headless run supplies credentials with no browser flow. Never commit secrets; how the config references them.
- Precedence and validation: how config layers merge, and fail-fast on a bad/incomplete config (better than a silent half-connect headless).

Output: the config schema + secrets/auth contract.

## Resolution

**Format & source:** a config file resolved in order `mcp-client.config.ts` → `.js` → `.json` → `.yaml` (first found), plus env overrides. The TS/JS form lets SDK users build config programmatically; JSON/YAML serves declarative/headless setups. Also accepted: pass a config object directly to `new McpClient(config)`.

**Schema (zod-validated, fail-fast):**
```ts
{
  servers: {
    [name: string]:
      | { transport: 'stdio', command: string, args?: string[], env?: Record<string,string> }
      | { transport: 'http',  url: string, headers?: Record<string,string>, auth?: AuthConfig }
    // per-server, optional:
    //   tools?: { [toolName]: ResultFilterPolicy }   // hooks F1
    //   search?: { boost?: number }                  // hooks S1
  },
  cache?: boolean,            // C1, default true
  search?: { embedder?: Embedder, topK?: number },  // S1
  defaults?: { maxTokens?: number }                 // F1 global cap
}
```

**Secrets — no inline secrets, headless-safe:**
- Config values support `${ENV_VAR}` interpolation; secrets live only in env / a secrets manager, never in the committed file.
- **stdio** servers get credentials via `env` (which itself interpolates from the process env) — fully headless (per R1).
- **http** auth (`AuthConfig`), all browserless (per R1): (a) `{ type:'bearer', token:'${TOKEN}' }` injected as a header; (b) `{ type:'oauth', tokens:'${...}' }` pre-provisioned tokens seeded into the SDK's `OAuthClientProvider` so it skips the interactive flow; (c) `{ type:'client_credentials', clientId, clientSecret, tokenUrl }` machine grant.
- Interactive OAuth (browser) is **attended-only** and never required for a server that has pre-provisioned credentials.

**Precedence:** built-in defaults < config file < env overrides < explicit constructor arg.

**Validation:** parse+validate the whole config up front; on a bad/incomplete config, **fail fast with a specific error** (better than a silent half-connect in headless). A per-server *connect/list* failure at init is the softer case handled in C1 (warn + skip + use cache), not a config error.
