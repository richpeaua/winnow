# Examples

Runnable examples. Most run with `npx tsx examples/<file>.ts` from the repo root after `npm install`. Ones marked **network** shell out to `npx` to launch a real MCP server; ones marked **build** need `npm run build` first.

| Example | What it shows | Run |
|---|---|---|
| `demo.ts` | End-to-end SDK flow (`search → loadTool → call`) against mock servers, with the token savings printed. | `npm run demo` |
| `exec-demo.ts` | `exec` / `run_code` composition: 30 fat PRs → filter stale in-sandbox → post each to Slack → return a tiny result (74× vs raw). | `npx tsx examples/exec-demo.ts` |
| `real-stdio.ts` | Drive a **real** MCP server (`@modelcontextprotocol/server-everything`) over stdio — connect, search, load, call. **network** | `npx tsx examples/real-stdio.ts` |
| `real-http.ts` | Stand up a local Streamable-HTTP MCP server that **requires a bearer token**, then drive it — proves the HTTP transport + auth injection. | `npx tsx examples/real-http.ts` |
| `gateway-server.ts` | The gateway entrypoint: aggregate an upstream behind Winnow and serve the 4 meta-tools over stdio. Launched by the demos below (what a host runs). | — |
| `gateway-demo.ts` | A raw MCP host → Winnow gateway → real upstream, all over stdio. The "install as a plugin" path. **network** | `npm run gateway:demo` |
| `gateway-dist-smoke.ts` | Run the **built** gateway with plain `node` from a config file (incl. `run_code`) — proves the packaged bin + sandbox worker. **build** **network** | `npm run build && npx tsx examples/gateway-dist-smoke.ts` |
| `servers.ts` | Mock upstream server definitions shared by the demos/tests. Not run directly. | — |
| `winnow.config.json` | A sample gateway config aggregating `server-everything`. | — |

New here? Start with `demo.ts`, then `exec-demo.ts`, then `gateway-demo.ts`.

See also: [Usage guide](../docs/USAGE.md) · [API reference](../docs/API.md) · [Config reference](../docs/CONFIG.md).
