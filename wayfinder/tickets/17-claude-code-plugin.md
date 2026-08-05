---
id: P5
title: Claude Code plugin package for the gateway
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1, integration]
status: closed
assignee: lpeaua
blocked_by: [P4]
map: map.md
---
## Question

Package the P4 gateway as an **installable Claude Code plugin** so users add Winnow via the plugin/marketplace flow rather than hand-editing MCP config.

- Provide the plugin manifest declaring the `winnow` MCP server (stdio: `npx -y mcp-winnow gateway ...`), plus where the user points their upstream-server config.
- Document the install path (`/plugin` / marketplace) and the minimal `winnow.config` a user supplies.

Acceptance: install the plugin into Claude Code, confirm the four meta-tools appear, and complete a `search_tools → call_tool` against a configured upstream (e.g. github). Depends on P4 (the gateway + bin must exist first).

## Resolution

Built the MCP-only plugin + marketplace, grounded in the current Claude Code plugin docs (verified via the claude-code-guide agent):
- `plugin/.claude-plugin/plugin.json` — MCP-only manifest (no commands/agents needed).
- `plugin/.mcp.json` — declares the `winnow` stdio server: `npx -y mcp-winnow gateway --config ${CLAUDE_PROJECT_DIR}/winnow.config.json`.
- `.claude-plugin/marketplace.json` (repo root) — lists the plugin, `source: ./plugin`.
- `plugin/winnow.config.example.json` + `plugin/README.md` — per-project upstream config + install docs.
- Made the CLI resilient: a missing config starts the gateway with zero upstreams (4 meta-tools still appear) instead of crashing — covered by a new test.

Install path: `/plugin marketplace add richpeaua/winnow` → `/plugin install winnow@winnow`. Tools surface as `mcp__plugin_winnow_winnow__*`.

**Verified:** all plugin/marketplace JSON valid + name-consistent; empty-config gateway serves 4 tools (unit test); the gateway itself is proven live (P4). **Not yet verified end-to-end in a live Claude Code** — that requires (a) `mcp-winnow` published to npm for `npx` to resolve (deferred go-decision from P3) or a local `npm link`, and (b) an interactive `/plugin install`. Documented both the npm path and the local-link override in `plugin/README.md`.
