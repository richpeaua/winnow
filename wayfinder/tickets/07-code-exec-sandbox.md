---
id: X1
title: Design the code-execution sandbox runtime & security
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: open
assignee:
blocked_by: [R1, R2]
map: map.md
---
## Question

How does the agent run code against MCP servers so results are filtered in-sandbox before hitting context? Decide the runtime and its guardrails (the codegen API shape is separate fog, graduates from here):
- Execution mechanism: `node:vm` / `isolated-vm` / `worker_threads` / subprocess / WASM (QuickJS) — pick per the sandbox survey, weighing isolation vs setup cost vs headless friendliness.
- What the sandboxed code may reach: only the generated server modules + a return channel; no ambient fs/net/env. How MCP calls bridge out of the sandbox.
- Resource limits: timeouts, memory, output-size cap on what the return value injects into context.
- Failure & security model: untrusted-code assumptions, error surfacing, and how a call still honors F1 result-filter caps.
- Relationship to the plain `call()` path — when does an agent use exec vs a single call?

Output: the sandbox runtime choice + the isolation/return contract.
