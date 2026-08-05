# Winnow — Claude Code plugin

Installs the **Winnow gateway** as a single MCP server. Instead of connecting N MCP servers directly (and paying for all their tool schemas + raw results in context), Claude Code connects to **one** server exposing just four tools — `search_tools`, `load_tool`, `call_tool`, `run_code` — while Winnow hides your N servers behind it.

`run_code` runs server-side in Winnow's sandbox, so you get multi-tool composition (return only the small computed result) without any of the raw data hitting context.

## Install

```
/plugin marketplace add richpeaua/winnow
/plugin install winnow@winnow
```

Then create **`winnow.config.json`** in your project root listing the MCP servers to aggregate (see `winnow.config.example.json`):

```json
{
  "servers": {
    "github": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" } }
  }
}
```

The tools appear as `mcp__plugin_winnow_winnow__search_tools`, etc.

## Prerequisite: `mcp-winnow` on npm

The plugin's server command is `npx -y mcp-winnow gateway …`, so it requires the **`mcp-winnow` package published to npm**. Until then, use a local override:

1. From the repo: `npm install && npm run build && npm link` (registers the `mcp-winnow` bin globally).
2. The same `npx -y mcp-winnow` resolves the linked bin, or point `.mcp.json`'s `command` at `node` + an absolute path to `dist/gateway/cli.js` for a fully local test.

## How it maps

| Plugin file | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | plugin manifest (MCP-only, no commands/agents) |
| `.mcp.json` | declares the `winnow` stdio MCP server (`npx -y mcp-winnow gateway`) |
| `winnow.config.example.json` | template for the per-project upstream-server list |
