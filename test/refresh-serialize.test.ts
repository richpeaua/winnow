// Issue #30: single-flight, coalescing refresh worker. Serializes catalog.refresh
// so no two SearchIndex.build runs interleave across the async embed window.
//
// The lost-update race is REAL only through the embed await: build() sets
// this.db/tools/byId synchronously at the top (so the last build to START wins
// them — always the fresh full tool set), but sets this.vectors/vecById AFTER the
// embed resolves (so the last build to RESOLVE wins them). Unserialized, a build
// over a STALE snapshot that resolves LAST clobbers the vector index with stale
// vectors while lexical/db stay fresh. So a presence assertion is VACUOUS (lexical
// always finds both tools); the defect is only detectable via a SEMANTIC-only,
// top-1 query. These tests use a concept embedder + a semantic-only query so an
// unserialized system DETERMINISTICALLY loses an update (proven by reverting the
// fix: whale->svcA:a_new instead of svcB:b_new).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Winnow, MockUpstream } from "../src/index.ts";
import type { Embedder, UpstreamConnection } from "../src/index.ts";

const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true }) });

/** Wraps an upstream to count listTools calls (and optionally throw N times). */
class Counting implements UpstreamConnection {
  listCount = 0;
  throwsLeft: number;
  constructor(private inner: UpstreamConnection, throwTimes = 0) { this.throwsLeft = throwTimes; }
  get server() { return this.inner.server; }
  get identity() { return this.inner.identity; }
  async listTools() { this.listCount++; if (this.throwsLeft > 0) { this.throwsLeft--; throw new Error("list failed"); } return this.inner.listTools(); }
  callTool(n: string, a: unknown) { return this.inner.callTool(n, a); }
  watch(cb: () => void | Promise<void>) { return (this.inner as any).watch(cb); }
  close() { return this.inner.close(); }
}

// Concept embedder: each text maps to a one-hot basis vector keyed by the first
// recognized keyword. Query terms are SYNONYMS of a tool's keyword that never
// appear literally in the tool text -> retrieval is semantic-only (BM25 misses).
const KW: Record<string, number> = { raptor: 0, griffin: 0, marine: 1, whale: 1, oldb: 2, olda: 3 };
const DIM = 5;
function conceptVec(text: string): number[] {
  let idx = 4;
  for (const w of text.toLowerCase().split(/\W+/)) if (w in KW) { idx = KW[w]!; break; }
  const v = new Array(DIM).fill(0); v[idx] = 1; return v;
}
/** Embedder whose svcA-ONLY build (embeds a_new/"raptor" but not b_new/"marine")
 *  resolves LAST. Unserialized, that stale build (snapshot {a_new, b_old}) then
 *  clobbers the fresh vectors set by svcB's build -> b_new's vector slot is lost. */
function raceEmbedder(): Embedder {
  return {
    fingerprint: "concept-v1",
    async embed(texts: string[]) {
      const hasA = texts.some((t) => t.includes("raptor"));
      const hasB = texts.some((t) => t.includes("marine"));
      const slow = hasA && !hasB; // svcA-only stale build -> resolve last
      await new Promise((r) => setTimeout(r, slow ? 80 : 2));
      return texts.map(conceptVec);
    },
  };
}

test("refresh-serialize: concurrent two-server refresh keeps BOTH semantically retrievable (no lost update)", async () => {
  // Non-vacuous: with the fix reverted, `whale` top-1 is svcA:a_new (b_new's
  // vector clobbered/lost); with the fix, it is svcB:b_new. Loop to prove it is
  // reliably passing on the fix (and, when reverted, reliably failing).
  for (let iter = 0; iter < 6; iter++) {
    const emb = raceEmbedder();
    const a = new MockUpstream("svcA", [tool("a_old", "olda placeholder")]);
    const b = new MockUpstream("svcB", [tool("b_old", "oldb placeholder")], 30); // delay -> svcA resolves first, snapshots {a_new,b_old}
    const w = new Winnow({ upstreams: [a, b], cache: false, embedder: emb });
    await w.init();

    a.setTools([tool("a_new", "raptor thing")]);
    b.setTools([tool("b_new", "marine thing")]);
    await Promise.all([w.refresh("svcA"), w.refresh("svcB")]);

    // Semantic-only, top-1: the discriminating assertions.
    const wh = await w.searchTools("whale", { topK: 1 });
    assert.equal(wh[0]?.id, "svcB:b_new", `iter ${iter}: b_new lost (whale top-1 = ${wh[0]?.id})`);
    const gr = await w.searchTools("griffin", { topK: 1 });
    assert.equal(gr[0]?.id, "svcA:a_new", `iter ${iter}: a_new lost (griffin top-1 = ${gr[0]?.id})`);

    // Consistency: hybrid stays true; catalog reflects the last-applied set of both.
    const ids = new Set(w.listTools().map((t) => t.id));
    assert.deepEqual([...ids].sort(), ["svcA:a_new", "svcB:b_new"]);
    await w.close();
  }
});

test("refresh-serialize: rapid single-server bursts coalesce (fewer re-lists than triggers)", async () => {
  const inner = new MockUpstream("svc", [tool("v0", "v0")], 20);
  const c = new Counting(inner);
  const w = new Winnow({ upstreams: [c], cache: false, watch: true });
  await w.init();
  const baseline = c.listCount; // 1 from init

  inner.setTools([tool("vN", "final version")]);
  const N = 10;
  // Trigger N refreshes without awaiting between them; listDelayMs keeps the drain
  // busy so later triggers coalesce into the same dirty-set entry.
  await Promise.all(Array.from({ length: N }, () => w.refresh("svc")));

  const relists = c.listCount - baseline;
  assert.ok(relists < N, `coalesced: ${relists} re-lists for ${N} triggers`);
  assert.ok(relists >= 1, "at least one re-list happened");
  assert.ok((await w.searchTools("vN")).some((h) => h.id === "svc:vN"), "final state correct");
  await w.close();
});

test("refresh-serialize: single refresh fires toolsChanged exactly once", async () => {
  const mock = new MockUpstream("svc", [tool("alpha", "Alpha")]);
  const w = new Winnow({ upstreams: [mock], cache: false });
  await w.init();
  let fired = 0;
  w.on("toolsChanged", () => { fired++; });
  mock.setTools([tool("beta", "Beta")]);
  await w.refresh("svc");
  assert.equal(fired, 1, "exactly one fire for one refresh");
  await w.close();
});

test("refresh-serialize: a throwing refresh does NOT wedge the worker", async () => {
  const inner = new MockUpstream("svc", [tool("alpha", "Alpha")]);
  const c = new Counting(inner); // no throw during init
  const w = new Winnow({ upstreams: [c], cache: false });
  await w.init();

  // Arm the next listTools to throw once, so refresh("svc") rejects.
  c.throwsLeft = 1;
  inner.setTools([tool("beta", "Beta")]);
  await assert.rejects(() => w.refresh("svc"), /list failed/, "refresh rejects on throw");

  // Worker must be reset — a subsequent refresh succeeds.
  inner.setTools([tool("gamma", "Gamma")]);
  await w.refresh("svc");
  assert.ok((await w.searchTools("gamma")).some((h) => h.id === "svc:gamma"), "subsequent refresh works");
  await w.close();
});

test("refresh-serialize: a failing WATCH-driven refresh is swallowed (no unhandled rejection) and does not wedge later refreshes", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const inner = new MockUpstream("svc", [tool("alpha", "Alpha")]);
    const c = new Counting(inner);
    const w = new Winnow({ upstreams: [c], cache: false, watch: true });
    await w.init();

    // A watch signal whose re-list throws: fire-and-forget, must NOT go unhandled.
    c.throwsLeft = 1;
    inner.setTools([tool("beta", "Beta")]);
    await inner.emitToolsChanged();
    // Let any microtask/rejection settle.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(unhandled.length, 0, "watch-driven refresh failure was swallowed, not unhandled");

    // Worker not wedged: a subsequent successful signal still applies.
    inner.setTools([tool("gamma", "Gamma")]);
    await inner.emitToolsChanged();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok((await w.searchTools("gamma")).some((h) => h.id === "svc:gamma"), "later watch refresh applies");
    assert.equal(unhandled.length, 0, "still no unhandled rejection");
    await w.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
