---
id: G1
title: Design the config & headless-safe secrets format
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
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
