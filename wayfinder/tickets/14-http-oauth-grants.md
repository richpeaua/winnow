---
id: P2
title: HTTP auth — pre-provisioned OAuth + client_credentials grants
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

Bearer auth is wired and live-verified (`examples/real-http.ts`). The other two browserless auth modes are config-typed (G1) but not yet constructed in `buildUpstreams`/`HttpUpstream`:
- **`oauth`** (pre-provisioned tokens): seed the SDK's `OAuthClientProvider.tokens()` so `connect` uses them and never opens a browser.
- **`client_credentials`**: implement the machine grant (POST clientId/clientSecret to `tokenUrl`, cache the access token, refresh on expiry), inject as the bearer.

All must stay fully headless (no interactive flow). Acceptance: a live test like `real-http.ts` but authenticating via each grant. Touches `src/upstream/http.ts`, `src/config.ts` (`buildUpstreams`).
