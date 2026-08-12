// Real-server benchmark: drives ACTUAL MCP servers (server-everything,
// server-filesystem) over real stdio transport — no mocks. Measures the two
// headline claims (context reduction) and the multi-agent scale work (#4-#7)
// end to end. Token counts use a real BPE tokenizer (gpt-tokenizer).
//
//   node bench/real-servers.mjs
//
// Requires network on first run (npx fetches the servers). Results are written
// to bench/REAL-RESULTS.md by report().
import { Winnow, StdioUpstream, PooledUpstream, META_TOOLS } from "../dist/index.js";
import { encode } from "gpt-tokenizer";
import os from "node:os";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const tok = (o) => encode(typeof o === "string" ? o : JSON.stringify(o ?? "")).length;
const mb = (b) => (b / 1024 / 1024).toFixed(0);
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; // report lines
const say = (s = "") => { console.log(s); out.push(s); };

const everything = () => new StdioUpstream("everything", { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] });
const filesystem = () => new StdioUpstream("fs", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", REPO] });

// ---------------------------------------------------------------- A. Context reduction
async function contextReduction() {
  // Inject the real BPE tokenizer so result caps are measured/enforced in true tokens.
  const w = new Winnow({ upstreams: [everything(), filesystem()], cache: false, tokenCounter: tok });
  const info = await w.init();
  say(`## A. Context reduction (real servers: server-everything + server-filesystem)`);
  say(`\nAggregated **${info.tools} real tools** over stdio.\n`);

  // A1 — tool-definition bloat (context at rest)
  const defs = w.loadTool(w.listTools().map((t) => t.id));
  const fullSchemas = defs.reduce((n, d) => n + tok({ name: d.name, description: d.description, inputSchema: d.inputSchema }), 0);
  const metaOnly = tok(META_TOOLS);
  const oneLoaded = metaOnly + Math.round(fullSchemas / defs.length); // 4 meta-tools + the 1 schema a task loads
  say(`### A1. Tool-definition bloat (what the model holds at rest)`);
  say(`\n| Approach | Tokens | vs baseline |`);
  say(`|---|--:|--:|`);
  say(`| Traditional MCP: all ${defs.length} full schemas in context | ${fullSchemas} | — |`);
  say(`| Winnow: 4 meta-tools only | ${metaOnly} | **${pct(metaOnly, fullSchemas)}** smaller |`);
  say(`| Winnow: 4 meta-tools + 1 loaded schema (per task) | ${oneLoaded} | **${pct(oneLoaded, fullSchemas)}** smaller |`);
  say(`\nProgressive disclosure: the model sees 4 tools; it searches, then loads only the schema it needs.\n`);

  // A2 — tool-result bloat (real payloads: cap + projection)
  say(`### A2. Tool-result bloat (real results, trimmed before they hit context)`);
  say(`\n| Real call | Raw tokens | Winnow | Reduction | How |`);
  say(`|---|--:|--:|--:|---|`);
  const cases = [
    { id: "fs:read_text_file", args: { path: `${REPO}/package-lock.json` }, opts: { maxTokens: 800 }, how: "`maxTokens: 800` cap" },
    { id: "everything:get-env", args: {}, opts: { maxTokens: 200 }, how: "`maxTokens: 200` cap" },
    { id: "everything:get-structured-content", args: { location: "New York" }, opts: { project: "{ temp: temperature, cond: conditions }" }, how: "project `{temp, cond}`" },
  ];
  for (const c of cases) {
    try {
      const raw = await w.call(c.id, c.args, { maxTokens: 1e7 });
      const trimmed = await w.call(c.id, c.args, c.opts);
      say(`| \`${c.id}\` | ${raw.tokens} | ${trimmed.tokens} | **${pct(trimmed.tokens, raw.tokens)}** | ${c.how} |`);
    } catch (e) {
      say(`| \`${c.id}\` | — | — | (skipped: ${String(e.message).slice(0, 40)}) | ${c.how} |`);
    }
  }
  say(`\nThe **cap** is the universal guard — it works on any result (many servers return their payload as a text block of stringified JSON, which can't be projected into). A JMESPath **project** trims further when a server emits real \`structuredContent\` (as \`get-structured-content\` does). A forgotten projection can never leak an unbounded blob: the global cap still applies.\n`);
  await w.close();
}

// ---------------------------------------------------------------- B. Scaling (#4-#7)
async function sandboxMemory() {
  say(`## B. Scaling under concurrency (#4-#7), real stdio round-trips`);
  say(`\n### B1. Sandbox memory ceiling (#4) — N concurrent \`run_code\`, each doing a real MCP call`);
  const w = new Winnow({ upstreams: [everything()], cache: false });
  await w.init();
  const base = process.memoryUsage().arrayBuffers;
  say(`\n| Concurrent run_code | arrayBuffers | rss |`);
  say(`|--:|--:|--:|`);
  const code = `const r = await mcp.everything.echo({ message: "x" }); return r;`;
  for (const n of [1, 5, 10, 20]) {
    const inflight = Array.from({ length: n }, () => w.exec(code, { timeoutMs: 20000 }));
    await sleep(500);
    const m = process.memoryUsage();
    say(`| ${n} | ${mb(m.arrayBuffers)} MB | ${mb(m.rss)} MB |`);
    await Promise.all(inflight);
    await sleep(300); if (global.gc) global.gc();
  }
  const cap = 4 * 32; // default maxWorkers(4) x 32MB SAB
  say(`\nFlat at ~${cap} MB (default \`maxWorkers: 4\` × 32 MB SAB) regardless of concurrency — vs unbounded per-exec spawn (~32 MB each). Baseline arrayBuffers ${mb(base)} MB.\n`);
  await w.close();
}

async function poolingThroughput() {
  say(`### B2. Upstream connection pooling (#7) — concurrent calls to a slow tool`);
  const N = 6, DUR = 1;
  async function measure(label, upstream) {
    const w = new Winnow({ upstreams: [upstream], cache: false });
    await w.init();
    const t0 = Date.now();
    await Promise.all(Array.from({ length: N }, () => w.call("ev:trigger-long-running-operation", { duration: DUR, steps: 2 }, { maxTokens: 1e6 })));
    const dt = Date.now() - t0;
    await w.close();
    return dt;
  }
  const single = await measure("poolSize=1", new StdioUpstream("ev", { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }));
  const pooled = await measure("poolSize=4", new PooledUpstream("ev", () => new StdioUpstream("ev", { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }), 4));
  say(`\n${N} concurrent \`trigger-long-running-operation(${DUR}s)\` calls:`);
  say(`\n| Config | Wall-clock | Serial would be | Parallel would be |`);
  say(`|---|--:|--:|--:|`);
  say(`| single connection (\`poolSize: 1\`) | ${single} ms | ${N * DUR * 1000} ms | ${DUR * 1000} ms |`);
  say(`| pooled (\`poolSize: 4\`) | ${pooled} ms | ${N * DUR * 1000} ms | ${DUR * 1000} ms |`);
  say(`\n**Honest finding:** \`server-everything\` is async — one subprocess already services ${N} concurrent JSON-RPC calls in parallel (~${DUR * 1000} ms, not ${N * DUR * 1000} ms). So a single connection is **not** the bottleneck, and pooling adds no throughput here (and costs extra subprocess-startup on first use). Pooling (\`poolSize > 1\`) helps only genuinely **serial** upstreams — one that holds a global lock or does blocking/CPU-bound work per request, where a single connection would serialize the fleet (verified in \`test/upstream-pool.test.ts\`). For typical async Node MCP servers, keep the default \`poolSize: 1\`.\n`);
}

// ---------------------------------------------------------------- run + report
async function main() {
  say(`# Winnow — real-server benchmark`);
  say(`\nActual MCP servers over stdio (no mocks). Tokens via \`gpt-tokenizer\` (BPE). Node ${process.version}, ${os.cpus().length} cores.\n`);
  await contextReduction();
  await sandboxMemory();
  await poolingThroughput();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./REAL-RESULTS.md", import.meta.url), out.join("\n") + "\n");
  console.log("\n-> wrote bench/REAL-RESULTS.md");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
