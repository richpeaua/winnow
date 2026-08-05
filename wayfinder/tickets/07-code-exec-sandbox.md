---
id: X1
title: Design the code-execution sandbox runtime & security
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
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

## Resolution

**Runtime — QuickJS-WASM** (`quickjs-emscripten`, per R2) as the default, wrapped in a `worker_thread` for hard timeout/memory enforcement. Rationale toward the goal: pure-WASM (no native build → sealed, headless-portable), capability-injected (the sandbox has *nothing* unless we hand it in), and a V8/QuickJS escape stays inside the WASM boundary. `isolated-vm` offered as an opt-in performance tier for trusted, high-throughput use. `node:vm`/`vm2` banned (not real isolation).

**What the sandboxed code can reach:** only (a) the generated typed server modules (see graduated ticket below) and (b) a `return`/output channel. **No ambient fs, net, env, process, or timers.** Every MCP call the code makes is a **capability-injected host function** that bridges out of the sandbox to the real MCP client — the code cannot open a connection itself.

**Resource limits:** per-exec wall-clock timeout, memory cap (worker-enforced), and an **output-size cap on the return value** that reuses the F1 global cap — so even a code path that returns a huge blob is trimmed before injection into context.

**Every bridged call still passes through the F1 result-filter** (projection + cap). Code-exec doesn't bypass result-bloat protection; it *adds* the ability to filter/aggregate across many calls in-sandbox so only a small computed result returns.

**exec vs call — when to use which:**
- `call(id, args, opts)` — one tool, one result. The common path.
- `exec(code)` — multi-tool composition, loops, joins, or filtering where you want N calls' results reduced to one small value *before* anything hits context. This is the biggest headless win (fewer model round-trips; deterministic in-code filtering).

**Security posture:** treat sandboxed code as untrusted. Errors surface as structured `{error}` values, never as host exceptions. No capability is ambient; all are injected per-exec, so the blast radius is exactly what we grant.

## Graduated fog

Resolving this (with C1) sharpens the **Generated typed code API** — the `server → TS module` codegen the sandbox executes against. Now a ticket: [Design the generated typed code API](10-generated-code-api.md).
