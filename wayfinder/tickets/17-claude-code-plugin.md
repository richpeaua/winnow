---
id: P5
title: Claude Code plugin package for the gateway
type: task
labels: [wayfinder:ticket, wayfinder:task, post-v1, integration]
status: open
assignee:
blocked_by: [P4]
map: map.md
---
## Question

Package the P4 gateway as an **installable Claude Code plugin** so users add Winnow via the plugin/marketplace flow rather than hand-editing MCP config.

- Provide the plugin manifest declaring the `winnow` MCP server (stdio: `npx -y mcp-winnow gateway ...`), plus where the user points their upstream-server config.
- Document the install path (`/plugin` / marketplace) and the minimal `winnow.config` a user supplies.

Acceptance: install the plugin into Claude Code, confirm the four meta-tools appear, and complete a `search_tools → call_tool` against a configured upstream (e.g. github). Depends on P4 (the gateway + bin must exist first).
