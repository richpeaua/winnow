// Warm-start init bench (issue #21). Proves the embedding sidecar: a cold build
// embeds every tool via the worker; a warm build (same cacheDir) reindexes from
// the flat Float32 sidecar with ZERO embeds. Also checks recall is unchanged.
//
// Run: npx tsx bench/warmstart.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SearchIndex, EmbeddingCache, localEmbedder } from "../src/index.js";
import type { Embedder, ToolDef } from "../src/types.js";
import { ALL_TOOLS } from "./fixtures.js";

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

function toDef(raw: any, salt = ""): ToolDef {
  const [server, name] = String(raw.name).split(":");
  const s = server + salt;
  return { id: `${s}:${name}`, server: s, name, description: raw.description, inputSchema: raw.inputSchema };
}

/** Wrap an embedder to count how many texts it actually embeds. */
function counting(inner: Embedder): Embedder & { embedded: () => number } {
  let n = 0;
  return {
    fingerprint: inner.fingerprint,
    embedded: () => n,
    async embedFlat(texts) { n += texts.length; return inner.embedFlat!(texts); },
    async embed(texts) { n += texts.length; return inner.embed(texts); },
    close: () => inner.close!(),
  };
}

// ~200 tools: replicate the 52 fixtures 4x with distinct ids/servers.
const tools: ToolDef[] = [];
for (let k = 0; k < 4; k++) for (const t of ALL_TOOLS) tools.push(toDef(t, k ? `_${k}` : ""));

const dir = path.join(os.tmpdir(), `winnow-warmstart-${process.pid}-${Date.now()}`);
fs.rmSync(dir, { recursive: true, force: true });

async function build(label: string): Promise<{ ms: number; embedded: number; hybrid: boolean }> {
  const cache = new EmbeddingCache(dir);
  const emb = counting(localEmbedder());
  const idx = new SearchIndex(emb);
  const t0 = now();
  await idx.build(tools, cache);
  const ms = now() - t0;
  await emb.close!();
  return { ms, embedded: emb.embedded(), hybrid: idx.hybrid };
}

console.log(`\n=== warm-start init bench (${tools.length} tools, all-MiniLM-L6-v2) ===`);
const cold = await build("cold");
console.log(`cold  : ${cold.ms.toFixed(1)}ms   embedded=${cold.embedded}  hybrid=${cold.hybrid}`);
const warm = await build("warm");
console.log(`warm  : ${warm.ms.toFixed(1)}ms   embedded=${warm.embedded}  hybrid=${warm.hybrid}`);
console.log(`speedup: ${(cold.ms / warm.ms).toFixed(0)}x   (warm embeds ${warm.embedded} of ${tools.length})`);

if (warm.embedded !== 0) { console.error("FAIL: warm build re-embedded — sidecar not hit"); process.exit(1); }
if (!warm.hybrid) { console.error("FAIL: warm build is not hybrid"); process.exit(1); }

// ---- recall through the real SearchIndex (unique fixtures only) ----
const recallDefs = ALL_TOOLS.map((t) => toDef(t));
const QUERIES: Array<{ q: string; exp: string[] }> = [
  { q: "list open pull requests", exp: ["github:list_pull_requests"] },
  { q: "get a single issue by its id", exp: ["github:get_issue"] },
  { q: "create a new git branch", exp: ["github:create_branch"] },
  { q: "list all slack channels", exp: ["slack:list_channels"] },
  { q: "select rows from a database table", exp: ["postgres:list_rows"] },
  { q: "add an index to a postgres table", exp: ["postgres:create_index"] },
  { q: "show me PRs that still need a reviewer", exp: ["github:list_pull_requests"] },
  { q: "send a notification to the team chat", exp: ["slack:create_message"] },
  { q: "read the contents of a file on disk", exp: ["filesystem:get_file"] },
  { q: "what tables exist in the database", exp: ["postgres:list_tables"] },
  { q: "search the web for articles about a topic", exp: ["websearch:list_results", "websearch:list_pages"] },
  { q: "cut a new software release", exp: ["github:create_release"] },
  { q: "rename a directory", exp: ["filesystem:update_directory"] },
  { q: "check the latest CI pipeline runs", exp: ["github:list_workflow_runs"] },
  { q: "look up a user profile", exp: ["slack:get_user"] },
  { q: "close an open issue", exp: ["github:update_issue"] },
];

const rEmb = localEmbedder();
const rIdx = new SearchIndex(rEmb);
await rIdx.build(recallDefs, new EmbeddingCache(path.join(dir, "recall")));
let hit = 0;
for (const { q, exp } of QUERIES) {
  const hits = await rIdx.search(q, 8);
  if (hits.some((h) => exp.includes(h.id))) hit++;
}
await rEmb.close!();
const pct = ((hit / QUERIES.length) * 100).toFixed(0);
console.log(`\nrecall@8 (hybrid, ${QUERIES.length} queries): ${hit}/${QUERIES.length} = ${pct}%`);

fs.rmSync(dir, { recursive: true, force: true });
if (hit !== QUERIES.length) { console.error(`FAIL: recall regressed (${pct}%)`); process.exit(1); }
console.log("OK\n");
