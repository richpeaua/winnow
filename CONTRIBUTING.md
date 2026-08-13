# Contributing to Winnow

Thanks for your interest in improving Winnow! This project fights MCP context bloat, and contributions of all sizes are welcome.

## Getting started

```bash
git clone https://github.com/Cambrionic/winnow.git
cd winnow
npm install
npm test          # unit + integration tests (fully offline)
npm run typecheck # tsc --noEmit
npm run build     # emit dist/
```

You need **Node >= 20**. The test suite is hermetic — no network, no external MCP servers required (it uses mocks, an in-memory transport, and local HTTP servers).

Handy scripts:

| Command | What it does |
|---|---|
| `npm run demo` | end-to-end SDK demo against mock servers |
| `npm run gateway:demo` | host → gateway → real `server-everything` (needs network for `npx`) |
| `npx tsx examples/real-stdio.ts` | drive a real MCP server over stdio |
| `npx tsx examples/exec-demo.ts` | sandboxed `run_code` composition |

## Project layout

```
src/        the SDK: client, catalog, search, filter, config, sandbox, upstream/, gateway/
examples/   runnable demos + mock servers
test/       node:test suites (offline)
bench/      token-reduction + search-recall benchmarks
docs/       DESIGN.md — the build-ready design spec
wayfinder/  the decision map the project was designed through (great context for "why")
plugin/     the Claude Code plugin package
```

New to the codebase? [`docs/DESIGN.md`](docs/DESIGN.md) explains every architectural decision and why, and `wayfinder/` records how they were reached.

## How to contribute

1. **Open an issue first** for anything non-trivial, so we can align on approach before you build.
2. **Branch** from `master` with a purpose-named branch (`feat/…`, `fix/…`, `docs/…`).
3. **Keep changes focused** — one concern per PR.
4. **Add or update tests** for any behavior change. Match the existing style in `test/`.
5. **Run the checks locally**: `npm run typecheck && npm test && npm run build` must all pass (CI runs the same on Node 20 and 22).
6. **Open a PR** into `master` and fill out the template. Link the issue it addresses.

## Conventions

- TypeScript, ESM. Relative imports in `src/` use `.js` specifiers (NodeNext) so `tsc` can emit — match the surrounding files.
- Prefer small, readable diffs that read like the code around them.
- Keep the design docs honest: if a change alters a decision in `docs/DESIGN.md`, update it in the same PR.
- Don't commit secrets. Config references secrets via `${ENV_VAR}` only.

## Reporting bugs / requesting features

Use the issue templates. For security issues, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
