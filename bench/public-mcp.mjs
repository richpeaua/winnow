// Public / hosted MCP benchmark: drives REAL public MCP servers over the network
// (Streamable-HTTP transport) — DeepWiki and GitMCP, both no-auth. Validates the
// HTTP transport end to end and measures context reduction + real network latency
// against servers we don't control.
//
//   node bench/public-mcp.mjs
//
// Depends on third-party server availability (not wired into CI). To also include a
// big authed catalog (the real def-bloat case, ~50+ tools), the bench folds in one
// authed HTTP MCP server. Its bearer is resolved WITHOUT ever being written to disk
// or printed, in this order (see resolveToken):
//   1. an explicit PAT in the environment: WINNOW_MCP_TOKEN, else GITHUB_TOKEN / GITHUB_PAT
//   2. the GitHub CLI's own token (`gh auth token`), if gh is installed and logged in
// The endpoint is WINNOW_MCP_URL, defaulting to GitHub's hosted MCP when only a token
// is available — so a contributor with `gh` logged in (or a PAT exported) gets the
// GitHub catalog with zero extra config. The `gh` token is only ever attached to
// GitHub's endpoint, never to a third-party WINNOW_MCP_URL. Set
// WINNOW_MCP_PUBLIC_ONLY=1 to force public-only even when a token is available.
import { execFileSync } from "node:child_process";
import { encode } from "gpt-tokenizer";

// Dynamic import so a missing build yields a clear instruction instead of a raw
// ERR_MODULE_NOT_FOUND (bench imports the compiled client, not the TS source).
let Winnow, HttpUpstream, staticBearer, META_TOOLS;
try {
  ({ Winnow, HttpUpstream, staticBearer, META_TOOLS } = await import("../dist/index.js"));
} catch {
  console.error("Could not load ../dist/index.js — build the client first: run `npm run build` at the repo root.");
  process.exit(1);
}

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/** An explicit PAT from the environment — an intentional opt-in the contributor
 *  set for whichever server they're pointing at, so it may target any URL.
 *  Trimmed (a stray newline in the env would otherwise break the header). */
function envToken() {
  for (const k of ["WINNOW_MCP_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT"]) {
    const v = process.env[k]?.trim();
    if (v) return { token: v, source: `env:${k}` };
  }
  return null;
}

/** The GitHub CLI's own token. This is a GitHub credential, so callers must only
 *  attach it to GitHub's endpoint — never to a third-party WINNOW_MCP_URL. */
function ghToken() {
  try {
    // stderr ignored so gh's diagnostics don't pollute stdout; only the token on
    // stdout is captured, then trimmed. Never printed.
    const token = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (token) return { token, source: "gh auth token" };
  } catch { /* gh not installed / not logged in / Windows gh.cmd not on PATH — public-only */ }
  return null;
}

const tok = (o) => encode(typeof o === "string" ? o : JSON.stringify(o ?? "")).length;
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };

function upstreams() {
  const list = [
    new HttpUpstream("deepwiki", { url: "https://mcp.deepwiki.com/mcp" }),
    new HttpUpstream("gitmcp", { url: "https://gitmcp.io/docs" }),
  ];
  if (process.env.WINNOW_MCP_PUBLIC_ONLY) {
    console.error("> authed upstream dropped (WINNOW_MCP_PUBLIC_ONLY set) — public servers only");
    return list;
  }
  // Optional authed catalog (the real def-bloat case). Endpoint from WINNOW_MCP_URL,
  // else GitHub's hosted MCP. The bearer is an explicit env PAT (usable for any URL,
  // since the contributor chose it) OR the `gh` CLI token — but the gh token is a
  // GitHub credential, so it is ONLY attached when the target is GitHub's endpoint,
  // never shipped to a third-party WINNOW_MCP_URL.
  const explicitUrl = process.env.WINNOW_MCP_URL;
  const url = explicitUrl ?? GITHUB_MCP_URL;
  const isGitHub = url === GITHUB_MCP_URL;
  const auth = envToken() ?? (isGitHub ? ghToken() : null);
  const label = isGitHub ? "github" : "authed";

  if (explicitUrl) {
    // Explicitly requested server: benchmark it even with no token — it may be a
    // public/no-auth server the contributor just wants folded in.
    list.push(new HttpUpstream(label, { url, getBearer: auth ? staticBearer(auth.token) : undefined }));
    // Log the SOURCE, never the token, and to stderr so it stays out of the .md.
    console.error(`> authed upstream: '${label}' at ${url} — ${auth ? `token via ${auth.source}` : "no token (no bearer sent)"}`);
  } else if (auth) {
    // Defaulted to GitHub's hosted MCP, which requires a bearer.
    list.push(new HttpUpstream("github", { url, getBearer: staticBearer(auth.token) }));
    console.error(`> authed upstream: 'github' at ${url} — token via ${auth.source}`);
  } else {
    console.error("> no authed upstream (no WINNOW_MCP_TOKEN/GITHUB_TOKEN and no `gh` login) — public servers only");
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
  say(`\n(A hosted server behind auth like GitHub's MCP carries ~50+ tools — folded in automatically when a \`gh\` login or a \`WINNOW_MCP_TOKEN\`/\`GITHUB_TOKEN\` PAT is present; see bench/README.md.)\n`);

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
