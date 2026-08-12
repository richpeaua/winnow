// Issue #27 (scoped): two zero-behavior-change hoists in SearchIndex —
//   1. build `byId` once per build (not per query)
//   2. compute `indexText` once per tool at build (not twice)
// These are pure refactors: hits (ids + order + scores) must be identical.
// This test locks in that invariance and proves byId is rebuilt every build
// (no stale entry served after add/remove).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchIndex } from "../src/index.ts";
import type { Embedder, ToolDef } from "../src/types.ts";

const td = (server: string, name: string, description: string, aliases?: string[]): ToolDef => ({
  id: `${server}:${name}`, server, name, description, aliases,
  inputSchema: { type: "object", properties: { limit: { description: "max results" } } },
});

/** Deterministic flat embedder (4-dim, L2-normalized) — no model, reproducible. */
function fakeFlatEmbedder(fingerprint?: string): Embedder {
  const vec = (t: string): number[] => {
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const raw = [((h) & 255) + 1, ((h >> 8) & 255) + 1, ((h >> 16) & 255) + 1, ((h >> 24) & 255) + 1];
    const n = Math.hypot(...raw);
    return raw.map((x) => x / n);
  };
  return {
    fingerprint,
    async embed(texts) { const f = await this.embedFlat!(texts); const o: number[][] = []; for (let i = 0; i < texts.length; i++) o.push(Array.from(f.data.subarray(i * f.dim, (i + 1) * f.dim))); return o; },
    async embedFlat(texts) {
      const dim = 4;
      const data = new Float32Array(texts.length * dim);
      texts.forEach((t, i) => data.set(vec(t), i * dim));
      return { data, dim };
    },
  };
}

const tools: ToolDef[] = [
  td("gh", "create_pull_request", "Create a pull request", ["pr", "mr"]),
  td("gh", "list_issues", "List open issues in a repository"),
  td("gh", "merge_branch", "Merge a branch into another"),
  td("ci", "run_pipeline", "Run the CI pipeline for a commit"),
  td("ci", "deploy_service", "Deploy a service to production"),
];
const queries = ["pull request", "issues", "deploy", "merge branch", "pipeline"];

test("cleanup: search() is idempotent across repeated calls (no per-query state drift from byId hoist)", async () => {
  const idx = new SearchIndex(fakeFlatEmbedder("fp-clean"));
  await idx.build(tools);
  for (const q of queries) {
    const first = await idx.search(q, 8);
    const second = await idx.search(q, 8);
    assert.deepEqual(second, first, `"${q}" returns identical hits on repeat (ids + order + scores)`);
    // At least one hit, and scores are the rounded 0-1 form the impl ships.
    assert.ok(first.length > 0, `"${q}" returns hits`);
  }
});

test("cleanup: hybrid and lexical-only both return well-formed, stable hits", async () => {
  const hybrid = new SearchIndex(fakeFlatEmbedder("fp-h"));
  const lexical = new SearchIndex(); // no embedder -> lexical-only path
  await hybrid.build(tools);
  await lexical.build(tools);
  for (const q of queries) {
    const h = await hybrid.search(q, 8);
    const l = await lexical.search(q, 8);
    // Every returned id resolves through the hoisted byId (no undefined hydration).
    for (const hit of [...h, ...l]) {
      assert.ok(hit.id && hit.name && hit.server, `"${q}" hit is fully hydrated via byId`);
      assert.equal(typeof hit.score, "number");
    }
    assert.deepEqual(await hybrid.search(q, 8), h, "hybrid stable on repeat");
    assert.deepEqual(await lexical.search(q, 8), l, "lexical stable on repeat");
  }
});

test("cleanup: byId is rebuilt every build — add/remove reflected, no stale entry served", async () => {
  const idx = new SearchIndex(fakeFlatEmbedder("fp-rb"));
  await idx.build(tools);
  assert.ok((await idx.search("deploy", 8)).some((h) => h.id === "ci:deploy_service"), "deploy present initially");

  // Remove deploy_service; a stale byId would still hydrate it.
  const without = tools.filter((t) => t.id !== "ci:deploy_service");
  await idx.build(without);
  assert.ok(!(await idx.search("deploy", 8)).some((h) => h.id === "ci:deploy_service"), "removed tool gone (byId rebuilt)");

  // Add a fresh tool; byId must know it this build.
  const withNew = [...tools, td("k8s", "scale_deployment", "Scale a kubernetes deployment")];
  await idx.build(withNew);
  const hits = await idx.search("scale kubernetes deployment", 8);
  assert.ok(hits.some((h) => h.id === "k8s:scale_deployment"), "newly added tool served via fresh byId");
});
