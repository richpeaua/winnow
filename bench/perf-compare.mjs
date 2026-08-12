// Perf regression baseline (issues #21-#24), using ONLY the stable public API
// (Winnow / MockUpstream / localEmbedder / filterResult) so the SAME script runs
// against any checkout — current tree by default, or an old one for a head-to-head.
//
//   npx tsx bench/perf-compare.mjs            # measure the current tree
//   npm run bench:perf                        # same, via package.json
//
// A/B against a baseline (e.g. a worktree at a pre-optimization commit):
//   git worktree add /tmp/base <old-commit> && ln -s "$PWD/node_modules" /tmp/base/node_modules
//   WINNOW_SRC=/tmp/base/src npx tsx bench/perf-compare.mjs   # baseline
//   npx tsx bench/perf-compare.mjs                            # current
//
// Metrics (each ties to a shipped optimization):
//   warm-start init   #21  flat Float32 embedding sidecar (warm reindex, zero re-embed)
//   incremental refresh #22 re-embed only changed tools
//   filter under-cap  #23  reuse the token count (one tokenization, not two)
//   filter truncate   #24  seeded-bracket tokenize-once truncation
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = process.env.WINNOW_SRC ?? new URL("../src/index.ts", import.meta.url).pathname;
const { Winnow, MockUpstream, localEmbedder, filterResult } = await import(SRC);

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms
const tmp = (t) => { const d = path.join(os.tmpdir(), `winnow-perf-${t}-${process.pid}-${Date.now()}`); fs.rmSync(d, { recursive: true, force: true }); return d; };

// 200 tools across 2 servers, varied text so embeddings are real work.
const verbs = ["list", "get", "create", "update", "delete", "search", "run", "sync", "fetch", "send"];
const nouns = ["issue", "pull request", "branch", "release", "workflow", "comment", "review", "label", "commit", "tag"];
function tools(server, n) {
  return Array.from({ length: n }, (_, i) => {
    const v = verbs[i % verbs.length], nn = nouns[(i * 7) % nouns.length];
    return {
      name: `${v}_${nn.replace(/ /g, "_")}_${i}`,
      description: `${v} a ${nn} on ${server}: option ${i} with pagination and filtering.`,
      inputSchema: { type: "object", properties: { id: { type: "string", description: `the ${nn} id` }, limit: { type: "integer", description: "max results" } } },
      handler: () => ({ ok: true }),
    };
  });
}

// #21 — warm-start init: cold (fresh cacheDir) then warm (same cacheDir, fresh
// embedder == fresh process). Pre-#21 the warm run re-embeds everything (no
// sidecar); with the sidecar it reindexes from disk and spawns zero workers.
async function warmStart() {
  const dir = tmp("warm");
  const up = () => [new MockUpstream("svcA", tools("svcA", 100)), new MockUpstream("svcB", tools("svcB", 100))];
  let w = new Winnow({ upstreams: up(), embedder: localEmbedder(), cacheDir: dir });
  let t = now(); await w.init(); const cold = now() - t; await w.close();
  w = new Winnow({ upstreams: up(), embedder: localEmbedder(), cacheDir: dir });
  t = now(); const wi = await w.init(); const warm = now() - t; await w.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { cold, warm, hybrid: wi.hybrid, fromCache: wi.fromCache.length };
}

// #22 — incremental refresh: change ONE of 200 tools, refresh that server. Same
// worker (model already loaded), so this is pure re-embed work. Pre-#22 re-embeds
// all 200; now only the changed tool (rest reused from the in-memory vecById).
async function refreshCost() {
  const a = new MockUpstream("svcA", tools("svcA", 100));
  const b = new MockUpstream("svcB", tools("svcB", 100));
  const w = new Winnow({ upstreams: [a, b], embedder: localEmbedder(), cache: false });
  await w.init();
  const changed = tools("svcA", 100);
  changed[0].description = "COMPLETELY DIFFERENT rewritten description for the first tool.";
  a.setTools(changed);
  const t = now(); await w.refresh("svcA"); const ms = now() - t;
  const found = (await w.searchTools("COMPLETELY DIFFERENT rewritten", { topK: 3 })).some((h) => h.id === "svcA:" + changed[0].name);
  await w.close();
  return { ms, found };
}

// #23/#24 — filter tokenization: an instrumented counter records how many times
// (and how many chars) the tokenizer runs. Under-cap should tokenize once (#23);
// a 500KB truncate should tokenize ~1x the payload, not ~2x (#24).
function filterTokenization() {
  const inst = () => { const s = { calls: 0, chars: 0 }; return { c: (x) => { s.calls++; s.chars += x.length; return Math.ceil(x.length / 4); }, s }; };
  const under = { structuredContent: Array.from({ length: 40 }, (_, i) => ({ i, tag: "small item" })) };
  const a = inst(); filterResult(under, { maxTokens: 2000 }, a.c, 2000);
  const big = { structuredContent: Array.from({ length: 2000 }, (_, i) => ({ i, blob: "Z".repeat(250) })) };
  const b = inst(); const r = filterResult(big, { maxTokens: 300 }, b.c, 2000);
  return {
    underCap: { calls: a.s.calls, chars: a.s.chars },
    truncate: { calls: b.s.calls, chars: b.s.chars, payloadChars: JSON.stringify(big.structuredContent).length, kept: r.truncated ? (r.note?._truncated?.kept ?? null) : null },
  };
}

const ws = await warmStart();
const rf = await refreshCost();
const ft = filterTokenization();

const ms = (x) => `${x.toFixed(1)}ms`;
console.log(`\n=== winnow perf baseline  (src: ${SRC})  200 tools, all-MiniLM-L6-v2 ===`);
console.log(`#21 warm-start init : cold ${ms(ws.cold)}  ->  warm ${ms(ws.warm)}   (${(ws.cold / ws.warm).toFixed(0)}x)   hybrid=${ws.hybrid} fromCache=${ws.fromCache}`);
console.log(`#22 refresh (1/200) : ${ms(rf.ms)}   changed-tool found=${rf.found}`);
console.log(`#23 filter under-cap: ${ft.underCap.calls} tokenization(s), ${ft.underCap.chars} chars`);
console.log(`#24 filter truncate : ${ft.truncate.calls} calls, ${ft.truncate.chars} chars tokenized for a ${ft.truncate.payloadChars}-char payload (${(ft.truncate.chars / ft.truncate.payloadChars).toFixed(2)}x), kept=${ft.truncate.kept}`);
console.log(JSON.stringify({ warmStart: ws, refresh: rf, filter: ft }));
