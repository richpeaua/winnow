---
id: A3
title: Define the attended vs headless behavior contract
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: [A2]
map: map.md
---
## Question

(Graduated from the "Attended vs headless behavioral differences" fog once the API surface (A2) settled.)
What actually differs between an attended run and a headless run, and how is that difference expressed without forking the core?

## Resolution

**Principle: the SDK core is fully non-interactive.** It never prompts, never opens a browser, never blocks on a human. Everything mode-specific is an *optional host-supplied hook* — absent hooks = headless behavior.

| Concern | Attended | Headless |
|---|---|---|
| Tool-call / exec approval | host passes `onBeforeCall(id,args)` / `onBeforeExec(code)` → may prompt a human, return allow/deny | hooks absent → auto-proceed |
| Embedding model | may be present → hybrid search | absent → lexical-only, **never auto-downloads** (S1) |
| Auth | interactive OAuth allowed | pre-provisioned bearer/oauth/client_credentials only (G1) |
| Logging | human-readable, verbose (injectable logger) | structured JSON, quiet |
| Config errors | same fail-fast; human reads it | same fail-fast; non-zero exit |

**Hooks (all optional):** `onBeforeCall`, `onBeforeExec`, `logger`. A host that supplies none gets deterministic headless behavior. This keeps a single code path — mode is an input, not a build flag — which is why every earlier ticket could hold "works in both" without special-casing.

**Non-negotiable invariants that hold in both modes:** the result-filter cap always applies (F1); no ambient sandbox capabilities (X1); no network for search unless an embedder is configured (S1); no secrets in the config file (G1).
