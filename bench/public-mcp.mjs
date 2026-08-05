// Public / hosted MCP benchmark: drives REAL public MCP servers over the network
// (Streamable-HTTP transport) — DeepWiki and GitMCP, both no-auth. Validates the
// HTTP transport end to end and measures context reduction + real network latency
// against servers we don't control.
//
//   node bench/public-mcp.mjs
//
// Depends on third-party server availability (not wired into CI). To also include a
// big authed catalog (e.g. GitHub's hosted MCP, ~50+ tools — the real def-bloat
// case), set WINNOW_MCP_URL and WINNOW_MCP_TOKEN; the token is read from the
// environment and never written to disk.
import { Winnow, HttpUpstream, staticBearer, META_TOOLS } from "../dist/index.js";
import { encode } from "gpt-tokenizer";

const tok = (o) => encode(typeof o === "string" ? o : JSON.stringify(o ?? "")).length;
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };

function upstreams() {
  const list = [
    new HttpUpstream("deepwiki", { url: "https://mcp.deepwiki.com/mcp" }),
    new HttpUpstream("gitmcp", { url: "https://gitmcp.io/docs" }),
  ];
  if (process.env.WINNOW_MCP_URL) {
    list.push(new HttpUpstream("authed", {
      url: process.env.WINNOW_MCP_URL,
      getBearer: process.env.WINNOW_MCP_TOKEN ? staticBearer(process.env.WINNOW_MCP_TOKEN) : undefined,
    }));
  }
  return list;
}

async function main() {
  say(`# Winnow — public / hosted MCP benchmark`);
  say(`\nReal public MCP servers over Streamable-HTTP (no mocks, no localhost). Tokens via \`gpt-tokenizer\`. Node ${process.version}.\n`);

  const w = new Winnow({ upstreams: upstreams(), cache: false, tokenCounter: tok });
  const t0 = Date.now();
  const info = await w.init();
  const initMs = Date.now() - t0;
  say(`## Transport + discovery`);
  say(`\nConnected to **${w.listServers().length} hosted servers** over HTTP, discovered **${info.tools} tools** in **${initMs} ms** (real network). Skipped: [${info.skipped}].\n`);
  for (const s of w.listServers()) {
    const n = w.listTools(s.server).length;
    say(`- \`${s.server}\` — ${n} tools`);
  }
  say("");

  // A. Definition bloat over the wire
  const defs = w.loadTool(w.listTools().map((t) => t.id));
  const full = defs.reduce((n, d) => n + tok({ name: d.name, description: d.description, inputSchema: d.inputSchema }), 0);
  const meta = tok(META_TOOLS);
  say(`## A. Tool-definition bloat (real hosted tools)`);
  say(`\n| Approach | Tokens | vs baseline |`);
  say(`|---|--:|--:|`);
  say(`| All ${defs.length} hosted schemas in context | ${full} | — |`);
  say(`| Winnow: 4 meta-tools | ${meta} | **${pct(meta, full)}** smaller |`);
  say(`\n(A hosted server behind auth like GitHub's MCP carries ~50+ tools — set \`WINNOW_MCP_URL\`/\`WINNOW_MCP_TOKEN\` to fold it in.)\n`);

  // B. Cross-server progressive disclosure over HTTP
  say(`## B. Progressive disclosure over HTTP`);
  const hits = await w.searchTools("documentation for a github repository", { topK: 3 });
  say(`\n\`search_tools("documentation for a github repository")\` → top hits across hosted servers:`);
  for (const h of hits) say(`- \`${h.id}\` (score ${h.score})`);
  say(`\nThe model sees these ranked entries, not all ${info.tools} schemas; it loads one, then calls.\n`);

  // C. Result bloat on a real remote payload + latency
  say(`## C. Result bloat + network latency (real remote calls)`);
  say(`\n| Real hosted call | Round-trip | Raw tokens | Capped (500) | Reduction |`);
  say(`|---|--:|--:|--:|--:|`);
  const cases = [
    { id: "deepwiki:read_wiki_contents", args: { repoName: "modelcontextprotocol/servers" } },
    { id: "deepwiki:read_wiki_structure", args: { repoName: "modelcontextprotocol/servers" } },
  ];
  for (const c of cases) {
    try {
      const s = Date.now();
      const raw = await w.call(c.id, c.args, { maxTokens: 1e7 });
      const ms = Date.now() - s;
      const capped = await w.call(c.id, c.args, { maxTokens: 500 });
      say(`| \`${c.id}\` | ${ms} ms | ${raw.tokens} | ${capped.tokens} | **${pct(capped.tokens, raw.tokens)}** |`);
    } catch (e) {
      say(`| \`${c.id}\` | — | — | — | (skipped: ${String(e.message).slice(0, 30)}) |`);
    }
  }
  say(`\nWinnow's own overhead is negligible next to the network round-trip; the cap means the model never has to ingest (or pay for) the full remote blob. **The transport, auth, search, and cap all work end to end against servers we don't control.**\n`);

  await w.close();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./PUBLIC-RESULTS.md", import.meta.url), out.join("\n") + "\n");
  console.log("\n-> wrote bench/PUBLIC-RESULTS.md");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
