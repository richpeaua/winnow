// Search-recall benchmark: does search surface the RIGHT tool from a
// natural-language query? Tests the spec stack: Orama BM25 (lexical, the
// headless floor) + Transformers.js embeddings (semantic) + RRF (hybrid).
import { create, insert, search } from "@orama/orama";
import { ALL_TOOLS } from "./fixtures.js";

// ---- indexable text per tool (name + description + param descriptions), per S1
function toolText(t) {
  const params = Object.entries(t.inputSchema.properties || {})
    .map(([k, v]) => `${k} ${v.description || ""}`).join(" ");
  const [server, name] = t.name.split(":");
  return `${server} ${name.replace(/_/g, " ")} ${t.description} ${params}`;
}

// ---- query set: expected = acceptable correct tool id(s). Mixed difficulty.
const QUERIES = [
  { q: "list open pull requests", exp: ["github:list_pull_requests"], hard: false },
  { q: "get a single issue by its id", exp: ["github:get_issue"], hard: false },
  { q: "create a new git branch", exp: ["github:create_branch"], hard: false },
  { q: "list all slack channels", exp: ["slack:list_channels"], hard: false },
  { q: "select rows from a database table", exp: ["postgres:list_rows"], hard: false },
  { q: "add an index to a postgres table", exp: ["postgres:create_index"], hard: false },
  { q: "show me PRs that still need a reviewer", exp: ["github:list_pull_requests"], hard: true },
  { q: "send a notification to the team chat", exp: ["slack:create_message"], hard: true },
  { q: "read the contents of a file on disk", exp: ["filesystem:get_file"], hard: true },
  { q: "what tables exist in the database", exp: ["postgres:list_tables"], hard: true },
  { q: "search the web for articles about a topic", exp: ["websearch:list_results", "websearch:list_pages"], hard: true },
  { q: "cut a new software release", exp: ["github:create_release"], hard: true },
  { q: "rename a directory", exp: ["filesystem:update_directory"], hard: true },
  { q: "check the latest CI pipeline runs", exp: ["github:list_workflow_runs"], hard: true },
  { q: "look up a user profile", exp: ["slack:get_user"], hard: true },
  { q: "close an open issue", exp: ["github:update_issue"], hard: true },
];

// ---- lexical (Orama BM25) -> ranked list of tool ids
async function buildLexical() {
  const db = create({ schema: { id: "string", text: "string" } });
  for (const t of ALL_TOOLS) await insert(db, { id: t.name, text: toolText(t) });
  return async (q) => {
    const res = await search(db, { term: q, limit: ALL_TOOLS.length, threshold: 1 });
    return res.hits.map((h) => h.document.id);
  };
}

// ---- semantic (Transformers.js all-MiniLM) -> ranked list; null if unavailable
async function buildSemantic() {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    const embed = async (texts) => {
      const out = await extract(texts, { pooling: "mean", normalize: true });
      return out.tolist();
    };
    const toolVecs = await embed(ALL_TOOLS.map(toolText));
    const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // normalized -> dot = cosine
    return async (q) => {
      const [qv] = await embed([q]);
      return ALL_TOOLS
        .map((t, i) => ({ id: t.name, s: cos(qv, toolVecs[i]) }))
        .sort((a, b) => b.s - a.s)
        .map((r) => r.id);
    };
  } catch (e) {
    console.log(`  (semantic unavailable: ${String(e).split("\n")[0]}) -> reporting lexical-only`);
    return null;
  }
}

// ---- RRF fusion of two ranked lists
function rrf(listA, listB, k = 60) {
  const score = new Map();
  const add = (list) => list.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (k + i + 1)));
  add(listA); add(listB);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

// ---- metrics
function rankOf(ranked, exp) {
  for (let i = 0; i < ranked.length; i++) if (exp.includes(ranked[i])) return i + 1;
  return Infinity;
}
function evaluate(name, ranker, subset) {
  let r1 = 0, r3 = 0, r8 = 0, mrrSum = 0;
  const misses = [];
  for (const { q, exp, ranked } of subset.map((it) => ({ ...it, ranked: it._ranked[name] }))) {
    const rank = rankOf(ranked, exp);
    if (rank <= 1) r1++;
    if (rank <= 3) r3++;
    if (rank <= 8) r8++;
    mrrSum += rank === Infinity ? 0 : 1 / rank;
    if (rank > 8) misses.push(`"${q}" -> want ${exp[0]}, got #${rank === Infinity ? ">52" : rank}`);
  }
  const n = subset.length;
  return { name, n, r1: r1 / n, r3: r3 / n, r8: r8 / n, mrr: mrrSum / n, misses };
}

// ---- run
const lex = await buildLexical();
console.log("loading semantic model (first run downloads ~23MB)...");
const sem = await buildSemantic();

for (const item of QUERIES) {
  item._ranked = {};
  item._ranked.lexical = await lex(item.q);
  if (sem) {
    item._ranked.semantic = await sem(item.q);
    item._ranked.hybrid = rrf(item._ranked.lexical, item._ranked.semantic);
  }
}

const methods = sem ? ["lexical", "semantic", "hybrid"] : ["lexical"];
const pctf = (x) => (x * 100).toFixed(0) + "%";
const line = "-".repeat(78);
console.log("\n" + line);
console.log(`SEARCH RECALL — ${ALL_TOOLS.length} tools, ${QUERIES.length} queries (${QUERIES.filter((q) => q.hard).length} hard paraphrases)`);
console.log(line);
console.log("method     n   recall@1  recall@3  recall@8   MRR");
for (const m of methods) {
  const all = evaluate(m, m, QUERIES);
  console.log(`${m.padEnd(10)} ${all.n}   ${pctf(all.r1).padStart(6)}    ${pctf(all.r3).padStart(6)}    ${pctf(all.r8).padStart(6)}   ${all.mrr.toFixed(2)}`);
}
console.log("\n-- on HARD paraphrases only --");
const hard = QUERIES.filter((q) => q.hard);
for (const m of methods) {
  const h = evaluate(m, m, hard);
  console.log(`${m.padEnd(10)} ${h.n}   ${pctf(h.r1).padStart(6)}    ${pctf(h.r3).padStart(6)}    ${pctf(h.r8).padStart(6)}   ${h.mrr.toFixed(2)}`);
}
console.log("\n-- lexical misses (not in top-8) — these are what semantic must save --");
for (const line of evaluate("lexical", "lexical", QUERIES).misses) console.log("  " + line);

console.log("\n" + JSON.stringify({
  tools: ALL_TOOLS.length, queries: QUERIES.length,
  methods: Object.fromEntries(methods.map((m) => {
    const e = evaluate(m, m, QUERIES);
    return [m, { r1: +e.r1.toFixed(2), r3: +e.r3.toFixed(2), r8: +e.r8.toFixed(2), mrr: +e.mrr.toFixed(2) }];
  })),
}));
