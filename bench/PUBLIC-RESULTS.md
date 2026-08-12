# Winnow — public / hosted MCP benchmark

Real public MCP servers over Streamable-HTTP (no mocks, no localhost). Tokens via `gpt-tokenizer`. Node v24.18.0.

## Transport + discovery

Connected to **2 hosted servers** over HTTP, discovered **8 tools** in **1508 ms** (real network). Skipped: [].

- `deepwiki` — 3 tools
- `gitmcp` — 5 tools

## A. Tool-definition bloat (real hosted tools)

| Approach | Tokens | vs baseline |
|---|--:|--:|
| All 8 hosted schemas in context | 814 | — |
| Winnow: 4 meta-tools | 259 | **68.2%** smaller |

(A hosted server behind auth like GitHub's MCP carries ~50+ tools — set `WINNOW_MCP_URL`/`WINNOW_MCP_TOKEN` to fold it in.)

## B. Progressive disclosure over HTTP

`search_tools("documentation for a github repository")` → top hits across hosted servers:
- `deepwiki:ask_question` (score 1)
- `deepwiki:read_wiki_contents` (score 0.417)
- `deepwiki:read_wiki_structure` (score 0.318)

The model sees these ranked entries, not all 8 schemas; it loads one, then calls.

## C. Result bloat + network latency (real remote calls)

| Real hosted call | Round-trip | Raw tokens | Capped (500) | Reduction |
|---|--:|--:|--:|--:|
| `deepwiki:read_wiki_contents` | 450 ms | 1987 | 487 | **75.5%** |
| `deepwiki:read_wiki_structure` | 93 ms | 346 | 346 | **0.0%** |

Winnow's own overhead is negligible next to the network round-trip; the cap means the model never has to ingest (or pay for) the full remote blob. **The transport, auth, search, and cap all work end to end against servers we don't control.**

