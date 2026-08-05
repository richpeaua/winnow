---
id: P2
title: HTTP auth — pre-provisioned OAuth + client_credentials grants
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: closed
assignee: lpeaua
blocked_by: []
map: map.md
---
## Question

Bearer auth is wired and live-verified (`examples/real-http.ts`). The other two browserless auth modes are config-typed (G1) but not yet constructed in `buildUpstreams`/`HttpUpstream`:
- **`oauth`** (pre-provisioned tokens): seed the SDK's `OAuthClientProvider.tokens()` so `connect` uses them and never opens a browser.
- **`client_credentials`**: implement the machine grant (POST clientId/clientSecret to `tokenUrl`, cache the access token, refresh on expiry), inject as the bearer.

All must stay fully headless (no interactive flow). Acceptance: a live test like `real-http.ts` but authenticating via each grant. Touches `src/upstream/http.ts`, `src/config.ts` (`buildUpstreams`).

## Resolution

`src/auth.ts` `BearerProvider` token sources, all browserless:
- `staticBearer(token)` — the existing `bearer` type.
- `preProvisionedOAuth(tokens)` — accepts a raw access token or a JSON token set `{access_token,…}`; uses the access token directly as the Bearer (a pre-provisioned valid token needs no flow — simpler and equivalent to seeding `OAuthClientProvider.tokens()`).
- `clientCredentials({clientId, clientSecret, tokenUrl, scope?})` — POSTs the OAuth 2.0 client_credentials grant, caches the access token, and refreshes when it nears expiry (30s buffer).

`HttpUpstream` resolves the bearer via `getBearer` on every connect and **reconnects when a refreshed token changes it** (so expiry-refresh actually takes effect). `buildUpstreams` maps each `auth.type` to the right provider.

**Verified live** (`test/http-auth.test.ts`, in-process server with a `/token` endpoint + bearer-gated `/mcp`): client_credentials fetches a token and authenticates; pre-provisioned oauth authenticates; wrong client secret → token request fails → server skipped (no tools leaked). Suite 23/23.

Note: a token that expires mid-session refreshes on the next connect (token change → reconnect); an active `watch` subscription would need re-registering after such a reconnect — minor, noted for the watch/long-lived path.
