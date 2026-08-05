# R1 — MCP Spec + TypeScript SDK Findings

**Spec revision cited:** `2026-07-28` (current authoritative revision; its schema.ts is the normative source). Prior stable revision was `2025-11-25`. The `2026-07-28` revision was locked 2026-05-21 and finalized 2026-07-28.
**Primary sources:**
- Spec index: https://modelcontextprotocol.io/specification/ (declares 2026-07-28 schema.ts authoritative)
- Transports: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- TS SDK (v2): `@modelcontextprotocol/client` **2.0.0** (implements 2026-07-28); legacy `@modelcontextprotocol/sdk` **1.30.0**. Repo: https://github.com/modelcontextprotocol/typescript-sdk
- SDK client docs: `docs/clients/connect.md`, `docs/clients/oauth.md` in the repo (main branch)

Retrieved 2026-08-04.

---

## 1. Transports

The current spec (2026-07-28) defines a transport as a **binding** — it frames/delivers messages but protocol semantics are identical across all bindings. Two standard transports are defined; a third (HTTP+SSE) is legacy/deprecated and only referenced for backward compatibility.

| Transport | Status | Message flow | Headless implications |
|---|---|---|---|
| **stdio** | Current, standard | Newline-delimited JSON-RPC over stdin/stdout of a client-launched subprocess. | Fully headless. No browser. Local subprocess. Auth spec explicitly says stdio **SHOULD NOT** use the OAuth flow — retrieve credentials from the environment. |
| **Streamable HTTP** | Current, standard | Each message is an HTTP POST to a single MCP endpoint; replies are a JSON object or a request-scoped SSE stream. Metadata mirrored into HTTP headers for routing. | Headless-capable at the transport level (plain HTTP). Needs a browser only if the server requires an interactive OAuth authorization-code flow AND no pre-provisioned token exists (see §5). |
| **HTTP+SSE (legacy)** | Deprecated | Two endpoints; long-lived SSE connection. Introduced 2024-11-05, replaced by Streamable HTTP in revision **2025-03-26**. | Same headless caveat as Streamable HTTP. Only implement as a fallback for old SSE-only servers; platforms are setting hard removal dates through 2026. |

Notes:
- 2026-07-28 removed the connection-scoped session and the `initialize` handshake (stateless, self-contained requests, per-request capability negotiation). Earlier revisions used an `initialize` handshake + session; a Backward Compatibility section defines era detection/fallback.
- Custom transports are allowed; reliable byte-stream transports SHOULD reuse stdio framing.
- **Headless takeaway:** stdio and Streamable HTTP both run without a browser; the only interactive step is a browser-based OAuth authorization-code grant, which is avoidable (§5).

Source: transports page; legacy-SSE deprecation confirmed via changelog + community migration notices.

---

## 2. Tool DEFINITION shape

A tool object (from `tools/list`) has these fields:

| Field | Required | Type | Indexable text? |
|---|---|---|---|
| `name` | Yes | string, unique per server. SHOULD be 1–128 chars, case-sensitive, `[A-Za-z0-9_.-]` only. | **Yes** (identifier/keyword) |
| `title` | No | Human-readable display name. | **Yes** (display text) |
| `description` | No | Human-readable description of functionality. | **Yes** (richest free-text signal) |
| `inputSchema` | Yes | JSON Schema (defaults to draft 2020-12). MUST be a valid object, not null. Property values may carry `x-mcp-header` to mirror params into HTTP headers. | Partial — property names + per-property `description` strings are indexable text |
| `outputSchema` | No | JSON Schema for structured output validation. | Partial — same as inputSchema |
| `annotations` | No | Optional properties describing tool behavior (e.g. audience/priority-style hints). **MUST be treated as untrusted unless from a trusted server.** | Some fields are text but low-trust; index with caution |
| `icons` | No | Array of `{src, mimeType, sizes}` for UI display. | No (binary/URL) |
| `_meta` | No | Protocol metadata namespace. | No |

**For a search index:** `name`, `title`, `description` are the high-value text fields; `inputSchema`/`outputSchema` property names and their `description` sub-fields add secondary signal. `annotations` text is untrusted and should be weighted/flagged accordingly.

Source: tools page → Data Types → Tool.

---

## 3. Tool RESULT shape

Result of `tools/call`. Every result carries `resultType` (e.g. `"complete"`, or `"input_required"` for multi-round-trip). Content is **structured**, **unstructured**, or both.

**Unstructured — `content[]`** array; block types:
- `text` — `{type:"text", text}`
- `image` — `{type:"image", data (base64), mimeType}`
- `audio` — `{type:"audio", data (base64), mimeType}`
- `resource_link` — `{type:"resource_link", uri, name, description, mimeType}` (a pointer, not embedded; not guaranteed to appear in `resources/list`)
- `resource` (embedded) — `{type:"resource", resource:{uri, mimeType, text|blob, annotations}}`
- All block types support optional `annotations` (audience, priority, lastModified).

**Structured — `structuredContent`**: any JSON value (object/array/scalar) conforming to `outputSchema` if defined. For backward compat a tool returning structured content SHOULD also serialize it into a `text` block. If `outputSchema` is set: server MUST conform, client SHOULD validate.

**`isError`**: boolean. Two error channels:
1. Protocol errors (unknown tool, malformed request) → JSON-RPC `error` object.
2. Tool execution errors (API/validation/business failures) → normal result with `isError: true` and text explaining the failure (fed back to the LLM for self-correction).

**Size / streaming / partial results:**
- No hard size cap in the spec. Results can be large (embedded resources, base64 media, big structuredContent) — a result-filter must expect and trim these.
- No token-level streaming of a single result. SSE on Streamable HTTP is request-scoped delivery of the JSON-RPC response, not partial-content streaming.
- Long-running / async work is the separate opt-in **Tasks** extension (call-now/fetch-later, polling, durable handles) — not part of the base tool result.
- Multi-round-trip: a call may return `resultType:"input_required"` with `inputRequests` (e.g. an `elicitation/create`) and `requestState`; the client retries `tools/call` with `inputResponses` (+ `requestState`) under a **new** JSON-RPC id.
- Stateful tools: no protocol session; servers pass an explicit opaque **handle** string in a result and accept it as an argument on later calls (non-normative guidance).

**Result-filter takeaway:** operate on `content[]` (per-type), `structuredContent`, and `isError`; be ready to truncate large text/media/resource payloads and to pass execution errors through to the model.

Source: tools page → Tool Result, Error Handling, Stateful Tools; Tasks extension referenced from spec index.

---

## 4. Catalog freshness (pagination + change notifications)

**Pagination:** `tools/list` supports opaque cursor pagination. Request may include `params.cursor`; response includes `nextCursor` when more pages exist (absent/null on the last page). Servers SHOULD return tools in a **deterministic order** so clients can cache the list and improve LLM prompt-cache hits.

**Caching metadata (new in 2026-07-28):** `tools/list` responses may include `ttlMs` and `cacheScope` (e.g. `"public"`) — explicit cache-lifetime hints a client can honor to reduce re-fetching.

**Change notifications:** Server declares capability `{"tools":{"listChanged":true}}`. When the tool set changes it SHOULD send `notifications/tools/list_changed`. In 2026-07-28 the client must first open a subscription stream via `subscriptions/listen` with `toolsListChanged: true` (server acks with `notifications/subscriptions/acknowledged`); the client then re-calls `tools/list`. The tool set MUST NOT vary per-connection, but MAY vary by the authorization presented on the request (per-request credentials, not connection state).

Source: tools page → Listing Tools, Capabilities, List Changed Notification; pagination + caching utility pages.

---

## 5. Auth — server authorization and HEADLESS credential supply

**Model (HTTP transports):** Authorization is OPTIONAL. When used, it is OAuth 2.1-based. The MCP server is an OAuth 2.1 **resource server**; the client is an OAuth 2.1 client; a separate **authorization server** issues tokens. Requirements:
- Servers **MUST** implement OAuth 2.0 Protected Resource Metadata (**RFC 9728**); clients MUST use it for AS discovery. Server advertises the resource-metadata URL via a `WWW-Authenticate` header on a 401.
- AS **MUST** expose RFC 8414 (OAuth AS Metadata) and/or OIDC Discovery; clients MUST support both.
- Client registration: Client ID Metadata Documents (preferred), pre-registration, or Dynamic Client Registration (RFC 7591, now **deprecated**, back-compat only).
- Tokens: `Authorization: Bearer <token>` on **every** HTTP request; never in the query string. Clients MUST send RFC 8707 `resource` param (canonical server URI) so tokens are audience-bound. Servers MUST validate audience and reject others. RFC 9207 `iss` validation required on the auth-code callback.
- **stdio**: SHOULD NOT use this OAuth flow — **retrieve credentials from the environment** instead.

**Headless credential supply without a browser** — three viable paths, all spec-supported:
1. **Pre-provisioned bearer token (static).** Just attach `Authorization: Bearer <token>`. The browser flow only exists to *obtain* a token; if you already hold one, no interactive step occurs. In the TS SDK, pass it via the transport's `requestInit.headers` (`StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ...' } } })`).
2. **Pre-seeded `OAuthClientProvider`.** The SDK reads `provider.tokens()` **before anything else** on `connect()`; a provider backed by durable storage that returns pre-provisioned `OAuthTokens` "**skips the browser round trip**" entirely (docs/clients/oauth.md). This is the clean headless path — no `redirectToAuthorization` is ever invoked when a token is present.
3. **Client-credentials grant (machine-to-machine).** Spec explicitly recognizes clients "acting on their own behalf (`client_credentials` clients)" — no user, no browser. The client obtains a token from the AS via the client-credentials grant and uses it as in (1)/(2). (Refresh-token grant likewise runs headlessly once a refresh token exists.)

**Headless takeaway:** browserless auth is fully supported. Prefer env-supplied credentials for stdio; for HTTP, inject a pre-provisioned bearer via `requestInit.headers`, or seed an `OAuthClientProvider.tokens()`/use the client-credentials grant. The browser is required only for a first-time interactive authorization-code grant with no pre-provisioned token.

Source: authorization page; TS SDK `docs/clients/oauth.md` and `docs/clients/connect.md`.

---

## TS SDK transport surface (for an embedded client)

From `@modelcontextprotocol/client` v2 (`docs/clients/connect.md`):
- `StreamableHTTPClientTransport(new URL(endpoint), opts)` — remote servers. `opts` supports `authProvider` (an `OAuthClientProvider`) and `requestInit` (fetch init incl. `headers`).
- `StdioClientTransport({ command, args })` — from `@modelcontextprotocol/client/stdio`; spawns a local subprocess.
- `SSEClientTransport(new URL(url))` — **fallback only** for older SSE-only (HTTP+SSE) servers. Recommended pattern: try Streamable HTTP first, retry with SSE on failure using a fresh `Client`.

---

## Implications for an embedded TS MCP-client SDK that fights context bloat

The result surface is where bloat originates: `tools/list` returns full `inputSchema`/`outputSchema`/`description`/`annotations` per tool, and `tools/call` returns unbounded `content[]` (text, base64 image/audio, embedded resources) plus `structuredContent` with no spec size cap — so the embedded client should (a) index only the high-signal, trusted text fields (`name`, `title`, `description`, schema property descriptions) for tool search while treating `annotations` as untrusted, and (b) run a result-filter over `content[]`/`structuredContent` that truncates or summarizes large/media/resource payloads and forwards `isError` execution errors verbatim for model self-correction. Freshness is cheap to exploit: honor deterministic ordering, `nextCursor` pagination, and the new `ttlMs`/`cacheScope` cache hints to cache the catalog and only refresh on `notifications/tools/list_changed` (via the `subscriptions/listen` stream), keeping the tool manifest out of the prompt except when it changes. Transport-wise, target Streamable HTTP + stdio (SSE only as a legacy fallback), and keep auth fully headless — env credentials for stdio, and a durable-storage `OAuthClientProvider` (or `requestInit.headers` bearer / client-credentials grant) for HTTP so `connect()` never triggers a browser round trip in an embedded, non-interactive host.
