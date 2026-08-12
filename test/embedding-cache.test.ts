import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SearchIndex, EmbeddingCache } from "../src/index.ts";
import { Winnow, MockUpstream } from "../src/index.ts";
import type { Embedder, ToolDef } from "../src/types.ts";

function tmp(tag: string): string {
  const d = path.join(os.tmpdir(), `winnow-emb-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

const td = (server: string, name: string, description: string): ToolDef => ({
  id: `${server}:${name}`, server, name, description, inputSchema: { type: "object", properties: {} },
});

/** Deterministic embedder that records every text it embeds and how many batches
 *  it ran. `fingerprint` decides sidecar identity; omit to disable caching. */
function fakeEmbedder(fingerprint?: string) {
  const embedded: string[] = [];
  let calls = 0;
  // Stable 4-dim vector from the text so recall is reproducible without a model.
  const vec = (t: string): number[] => {
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const raw = [((h) & 255) + 1, ((h >> 8) & 255) + 1, ((h >> 16) & 255) + 1, ((h >> 24) & 255) + 1];
    const n = Math.hypot(...raw);
    return raw.map((x) => x / n); // L2-normalized, like the real embedder
  };
  const emb: Embedder & { embedded: string[]; calls: () => number } = {
    fingerprint,
    embedded,
    calls: () => calls,
    async embed(texts: string[]) { calls++; embedded.push(...texts); return texts.map(vec); },
  };
  return emb;
}

/** Fake that implements the flat fast path (embedFlat), like localEmbedder does,
 *  so we cover the Float32Array {data,dim} contract SearchIndex actually ships —
 *  not just the number[][] fallback. */
function fakeFlatEmbedder(fingerprint?: string) {
  let calls = 0;
  const vec = (t: string): number[] => {
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const raw = [((h) & 255) + 1, ((h >> 8) & 255) + 1, ((h >> 16) & 255) + 1, ((h >> 24) & 255) + 1];
    const n = Math.hypot(...raw);
    return raw.map((x) => x / n);
  };
  const emb: Embedder & { calls: () => number } = {
    fingerprint,
    calls: () => calls,
    async embed(texts) { const f = await this.embedFlat!(texts); const o: number[][] = []; for (let i = 0; i < texts.length; i++) o.push(Array.from(f.data.subarray(i * f.dim, (i + 1) * f.dim))); return o; },
    async embedFlat(texts) {
      calls++;
      const dim = 4;
      const data = new Float32Array(texts.length * dim);
      texts.forEach((t, i) => data.set(vec(t), i * dim));
      return { data, dim };
    },
  };
  return emb;
}

test("sidecar: flat (embedFlat) fast path caches and returns identical hits warm", async () => {
  const dir = tmp("flat");
  const cache = new EmbeddingCache(dir);
  const tools = [td("svc", "alpha", "Alpha tool for pull requests"), td("svc", "beta", "Beta tool for issues")];

  const cold = fakeFlatEmbedder("fp-flat");
  const iCold = new SearchIndex(cold);
  await iCold.build(tools, cache);
  assert.equal(cold.calls(), 1, "cold flat build embeds once");
  const coldTop = (await iCold.search("pull requests", 2)).map((h) => h.id);

  // Sidecar exists on disk and is exactly N*dim*4 bytes (flat Float32, zero-parse).
  const bin = fs.readdirSync(dir).find((f) => f.endsWith(".bin"))!;
  assert.ok(bin, "wrote a .bin sidecar");
  assert.equal(fs.statSync(path.join(dir, bin)).size, tools.length * 4 * 4, "N*dim*4 bytes");

  const warm = fakeFlatEmbedder("fp-flat");
  const iWarm = new SearchIndex(warm);
  await iWarm.build(tools, cache);
  assert.equal(warm.calls(), 0, "warm flat build embeds zero via the flat path");
  const warmTop = (await iWarm.search("pull requests", 2)).map((h) => h.id);
  assert.deepEqual(warmTop, coldTop, "warm (from sidecar) ranks identically to cold");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: a full hit re-embeds nothing and stays hybrid", async () => {
  const dir = tmp("full");
  const cache = new EmbeddingCache(dir);
  const tools = [td("svc", "alpha", "Alpha tool"), td("svc", "beta", "Beta tool")];

  const e1 = fakeEmbedder("fp-a");
  const i1 = new SearchIndex(e1);
  await i1.build(tools, cache);
  assert.equal(e1.calls(), 1, "cold build embeds once");
  assert.equal(e1.embedded.length, 2, "both tools embedded cold");
  assert.equal(i1.hybrid, true);

  const e2 = fakeEmbedder("fp-a"); // same fingerprint, fresh counter
  const i2 = new SearchIndex(e2);
  await i2.build(tools, cache);
  assert.equal(e2.calls(), 0, "warm build calls the embedder zero times");
  assert.equal(i2.hybrid, true, "still hybrid, reindexed from the sidecar");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: changing one tool's text re-embeds only that tool", async () => {
  const dir = tmp("partial");
  const cache = new EmbeddingCache(dir);
  const tools = [td("svc", "alpha", "Alpha tool"), td("svc", "beta", "Beta tool")];

  await new SearchIndex(fakeEmbedder("fp-b")).build(tools, cache);

  const changed = [tools[0]!, td("svc", "beta", "Beta tool REWRITTEN")];
  const e = fakeEmbedder("fp-b");
  await new SearchIndex(e).build(changed, cache);
  assert.equal(e.embedded.length, 1, "only the changed tool re-embeds");
  assert.ok(e.embedded[0]!.includes("REWRITTEN"), "and it is the changed one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: a different fingerprint (model/config change) invalidates everything", async () => {
  const dir = tmp("fp");
  const cache = new EmbeddingCache(dir);
  const tools = [td("svc", "alpha", "Alpha tool"), td("svc", "beta", "Beta tool")];

  await new SearchIndex(fakeEmbedder("fp-old")).build(tools, cache);

  const e = fakeEmbedder("fp-new"); // e.g. model swapped
  await new SearchIndex(e).build(tools, cache);
  assert.equal(e.embedded.length, 2, "whole sidecar invalid -> all re-embedded");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: no fingerprint -> caching disabled (always embeds)", async () => {
  const dir = tmp("nofp");
  const cache = new EmbeddingCache(dir);
  const tools = [td("svc", "alpha", "Alpha tool")];

  await new SearchIndex(fakeEmbedder(undefined)).build(tools, cache);
  const e = fakeEmbedder(undefined);
  await new SearchIndex(e).build(tools, cache);
  assert.equal(e.embedded.length, 1, "un-fingerprinted embedder never reads/writes the sidecar");
  assert.equal(fs.existsSync(dir), false, "nothing written");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: two catalogs sharing a dir don't clobber each other's vectors", async () => {
  const dir = tmp("share");
  const cache = new EmbeddingCache(dir);
  const a = [td("svcA", "alpha", "Alpha")];
  const b = [td("svcB", "beta", "Beta")];

  await new SearchIndex(fakeEmbedder("fp-s")).build(a, cache); // writes svcA:alpha
  await new SearchIndex(fakeEmbedder("fp-s")).build(b, cache); // must NOT drop svcA:alpha

  const eA = fakeEmbedder("fp-s");
  await new SearchIndex(eA).build(a, cache);
  assert.equal(eA.calls(), 0, "svcA:alpha survived the svcB write (merge, not clobber)");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sidecar: end-to-end warm init through Winnow re-embeds nothing", async () => {
  const dir = tmp("e2e");
  const tools = [{ name: "alpha", description: "Alpha tool", inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true }) }];

  const e1 = fakeEmbedder("fp-e2e");
  const w1 = new Winnow({ upstreams: [new MockUpstream("svc", tools)], embedder: e1, cacheDir: dir });
  const r1 = await w1.init();
  assert.equal(r1.hybrid, true);
  assert.ok(e1.calls() >= 1, "cold init embeds");

  const e2 = fakeEmbedder("fp-e2e");
  const w2 = new Winnow({ upstreams: [new MockUpstream("svc", tools)], embedder: e2, cacheDir: dir });
  const r2 = await w2.init();
  assert.deepEqual(r2.fromCache, ["svc"], "catalog served from disk");
  assert.equal(r2.hybrid, true);
  assert.equal(e2.calls(), 0, "warm init: zero embeds (no worker/model load)");
  assert.ok((await w2.searchTools("alpha")).some((h) => h.id === "svc:alpha"));
  fs.rmSync(dir, { recursive: true, force: true });
});
