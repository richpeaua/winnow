---
id: P3
title: Package for publish
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

The package currently exports raw `./src/index.ts` and runs via tsx. Make it publishable:
- Build to `dist/` (ESM + `.d.ts`); set `exports`, `main`/`types`, `files`, `engines`.
- Decide the optional-dependency story for `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `quickjs-emscripten` (peer vs optional) and document the degraded modes when absent.
- Ensure the sandbox worker (`src/sandbox-worker.ts`) resolves correctly from `dist` (no tsx loader in prod — verify the worker loads the built `.js`).
- Versioning (0.1.0), README install from the built package, a smoke test that imports from `dist`.

Acceptance: `npm pack` + install into a clean project runs the quickstart. Touches `package.json`, build config, `src/sandbox.ts` (worker URL resolution).
