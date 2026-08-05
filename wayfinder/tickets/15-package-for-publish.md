---
id: P3
title: Package for publish
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1]
status: closed
assignee: lpeaua
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

## Resolution

- **Build:** `tsconfig.build.json` emits `src → dist` (ESM + `.d.ts` + sourcemaps). Migrated all `src` relative imports from `.ts` → `.js` specifiers (NodeNext) so `tsc` can emit; typecheck of examples/tests keeps `allowImportingTsExtensions` via the base config. `npm run build` is clean.
- **Worker resolution:** `src/sandbox.ts` picks `./sandbox-worker.{ts|js}` from `import.meta.url`'s own extension — `.ts` under tsx, `.js` from `dist`. Verified `run_code` works from built `dist` with plain `node` (`examples/gateway-dist-smoke.ts`).
- **package.json:** `main`/`types`/`exports` (`.` + `./gateway`), `bin: mcp-winnow → dist/gateway/cli.js` (shebang preserved), `files: [dist, README, docs]`, `engines: node>=20`, `prepublishOnly: build`, version `0.1.0`. Resolved a duplicate `quickjs-emscripten` dep; only `@huggingface/transformers` stays optional (lexical fallback covers its absence).
- **Acceptance met:** `npm pack` → install into a clean project → `import('mcp-winnow')` exports `Winnow`/`createGateway`, and `node_modules/.bin/mcp-winnow` runs. So `npx -y mcp-winnow gateway …` will work once published.
- **Deferred:** kept `private: true` (publishing to the npm registry is a separate go-decision); a LICENSE is still to be chosen before any public publish.
