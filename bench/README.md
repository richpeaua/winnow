# Winnow benchmarks

Three benchmarks measure the context-bloat reduction Winnow gives an MCP host.
All use a real BPE tokenizer (`gpt-tokenizer`) for token counts.

| Script | What it drives | Auth |
|---|---|---|
| `npm run bench` | Synthetic fixtures (fast, deterministic) | none |
| `npm run bench:real` | Real local MCP servers over **stdio** (`everything`, `filesystem`) | none |
| `npm run bench:public` | Real **hosted** MCP servers over Streamable-HTTP (DeepWiki, GitMCP, + optional authed catalog) | optional (see below) |

Run from this `bench/` directory (`cd bench && npm install` once). `bench:public`
imports the built client, so build first from the repo root: `npm run build`.

## `bench:public` — the authed catalog (GitHub hosted MCP)

DeepWiki and GitMCP are no-auth and always included. To exercise the real
definition-bloat case, the bench also folds in **one authed HTTP MCP server**
(GitHub's hosted MCP carries ~50+ tools). You do not need to hardcode anything —
the bearer is resolved in this order:

1. **An explicit PAT in the environment** — `WINNOW_MCP_TOKEN`, else `GITHUB_TOKEN`, else `GITHUB_PAT`. An env PAT is an explicit opt-in, so it is used for whatever `WINNOW_MCP_URL` you set.
2. **The GitHub CLI token** — `gh auth token`, if `gh` is installed and you're logged in (`gh auth login`). This is a GitHub credential, so it is **only** attached when the target is GitHub's endpoint — it is never sent to a third-party `WINNOW_MCP_URL`. (On Windows the `gh` lookup may not resolve; export a PAT instead.)

The **endpoint** is `WINNOW_MCP_URL`, and defaults to GitHub's hosted MCP
(`https://api.githubcopilot.com/mcp/`) when unset. Point `WINNOW_MCP_URL` at any
other HTTP MCP server to benchmark that instead — with an env PAT if it needs
auth, or with no token at all if it's public.

### Examples

```sh
# Zero-config: already logged in with the GitHub CLI
npm run bench:public

# Explicit PAT (never pass it as a CLI arg; keep it in the env)
WINNOW_MCP_TOKEN=github_pat_xxx npm run bench:public

# A different authed HTTP MCP server
WINNOW_MCP_URL=https://your-mcp.example/mcp/ WINNOW_MCP_TOKEN=xxx npm run bench:public

# Public servers only, even though a token is available
WINNOW_MCP_PUBLIC_ONLY=1 npm run bench:public
```

If no token resolves, the bench degrades cleanly to the two public servers.

### PAT permissions

The bench only **lists** the authed server's tools (for the bloat table and
cross-server search) — it never **calls** one, so a **read-only** token is enough.
For GitHub's hosted MCP, a fine-grained PAT with *Metadata: Read* plus
*Contents / Issues / Pull requests: Read* surfaces a representative catalog;
under-scoping just shows fewer tools. A `gh` CLI token works as-is.

### Token handling

The token is read from the environment (or `gh`) at runtime, used only as an
`Authorization: Bearer` header, and is **never written to disk or logged** — the
bench prints only the token *source* (e.g. `token via gh auth token`) to stderr,
never the value. `bench/PUBLIC-RESULTS.md` contains tool names/counts/scores
only. Note those results are derived from whatever toolset your token can see, so
avoid committing an account-specific `PUBLIC-RESULTS.md` unless that's intended.
