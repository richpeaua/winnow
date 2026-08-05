---
id: P4
title: Gateway adapter — run Winnow as an MCP server (stdio + HTTP)
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1, integration]
status: open
assignee:
blocked_by: []
map: map.md
---
## Question

Make Winnow **installable into any MCP host with no code** (the "install as a plugin" path). Graduated from the "thin gateway adapter" fog once the SDK, meta-tool adapter (A2), and sandbox (X1) were built.

Build a gateway: an MCP **server** (via `@modelcontextprotocol/sdk` `McpServer`) that exposes exactly the four meta-tools — `search_tools`, `load_tool`, `call_tool`, `run_code` — backed by a `Winnow` instance constructed from config (the upstream servers it aggregates). The host connects to ONE server and sees FOUR tools while Winnow hides N upstream tools behind search/load/call.

- **Transports:** stdio (local desktop hosts) + Streamable-HTTP with bearer auth (remote/hosted). Server-side auth mirrors the client-side auth already built.
- **Bin:** a `mcp-winnow gateway --config winnow.config.json` entry so `npx -y mcp-winnow gateway` just works (pairs with P3 packaging).
- **`run_code` clarification:** over the gateway it runs **server-side in Winnow's sandbox** against the real upstreams — full power. The only thing gateway consumers lose vs the direct SDK is *dev-time TypeScript types* on the generated `mcp.*` API (irrelevant for Claude Desktop/Cursor/Python). (Corrects the earlier "degrades to a generic exec tool" framing.)

Acceptance: add the stdio server entry to a real host (or drive it with the SDK's own client) and complete search → load → call → run_code end-to-end; plus an HTTP deploy example authenticating with a bearer. Touches new `src/gateway/`, a `bin`, and packaging (P3).
