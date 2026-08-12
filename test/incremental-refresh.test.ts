// Issue #22: in-memory incremental embedding in SearchIndex. A refresh must
// re-embed ONLY new/changed tools, reusing in-memory vectors for unchanged ones
// — independent of the disk sidecar, so it holds even with `cache: false`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SearchIndex, EmbeddingCache } from "../src/index.ts";
import { Winnow, MockUpstream } from "../src/index.ts";
import type { Embedder, ToolDef } from "../src/types.ts";

function tmp(tag: string): string {
  const d = path.join(os.tmpdir(), `winnow-inc-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

const td = (server: string, name: string, description: string): ToolDef => ({
  id: `${server}:${name}`, server, name, description, inputSchema: { type: "object", properties: {} },
});

/** Counting embedder that records every text it embeds. No fingerprint -> the
 *  disk sidecar is disabled, so only the in-memory path (#22) can save embeds. */
function fakeEmbedder(fingerprint?: string) {
  const embedded: string[] = [];
  let calls = 0;
  const vec = (t: string): number[] => {
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const raw = [((h) & 255) + 1, ((h >> 8) & 255) + 1, ((h >> 16) & 255) + 1, ((h >> 24) & 255) + 1];
    const n = Math.hypot(...raw);
    return raw.map((x) => x / n);
  };
  const emb: Embedder & { embedded: string[]; calls: () => number } = {
    fingerprint,
    embedded,
    calls: () => calls,
    async embed(texts: string[]) { calls++; embedded.push(...texts); return texts.map(vec); },
  };
  return emb;
}

test("incremental: SearchIndex.build re-embeds only the changed tool across two builds (cache: false path)", async () => {
  const e = fakeEmbedder(); // no fingerprint -> no disk sidecar; in-memory only
  const idx = new SearchIndex(e);

  const svcA = [td("svcA", "a1", "Alpha one"), td("svcA", "a2", "Alpha two")];
  const svcB = [td("svcB", "b1", "Beta one"), td("svcB", "b2", "Beta two")];

  await idx.build([...svcA, ...svcB]);
  assert.equal(e.embedded.length, 4, "cold build embeds all 4 tools");

  // Refresh: svcB changes one tool's text (b2 rewritten), b1 unchanged.
  e.embedded.length = 0;
  const svcB2 = [td("svcB", "b1", "Beta one"), td("svcB", "b2", "Beta two REWRITTEN")];
  await idx.build([...svcA, ...svcB2]);

  assert.equal(e.embedded.length, 1, "only the changed tool re-embeds");
  assert.ok(e.embedded[0]!.includes("REWRITTEN"), "and it is the changed one");
  assert.equal(idx.hybrid, true);
});

test("incremental: unchanged-server search results are identical before/after refreshing another server", async () => {
  const e = fakeEmbedder();
  const idx = new SearchIndex(e);
  const svcA = [td("svcA", "search", "Search pull requests"), td("svcA", "list", "List open issues")];
  const svcB = [td("svcB", "deploy", "Deploy the service")];

  await idx.build([...svcA, ...svcB]);
  const before = (await idx.search("pull requests", 8)).filter((h) => h.server === "svcA").map((h) => h.id);

  // Change svcB entirely; svcA untouched.
  await idx.build([...svcA, td("svcB", "rollback", "Rollback the service")]);
  const after = (await idx.search("pull requests", 8)).filter((h) => h.server === "svcA").map((h) => h.id);

  assert.deepEqual(after, before, "unchanged server ranks identically after a refresh of another server");
});

test("incremental: a removed tool is pruned and its vector is not reused", async () => {
  const e = fakeEmbedder();
  const idx = new SearchIndex(e);
  const tools = [td("svc", "keep", "Keep this tool"), td("svc", "drop", "Drop this tool")];
  await idx.build(tools);
  assert.ok((await idx.search("drop", 8)).some((h) => h.id === "svc:drop"), "drop present before");

  // Refresh without the dropped tool.
  await idx.build([td("svc", "keep", "Keep this tool")]);
  assert.ok(!(await idx.search("drop", 8)).some((h) => h.id === "svc:drop"), "dropped tool gone from search");

  // Re-adding it must re-embed (its in-memory entry was pruned, not reused).
  e.embedded.length = 0;
  await idx.build([td("svc", "keep", "Keep this tool"), td("svc", "drop", "Drop this tool")]);
  assert.ok(e.embedded.some((t) => t.includes("Drop this tool")), "re-added tool is re-embedded, no stale reuse");
});

test("incremental: end-to-end Winnow.refresh with cache:false embeds only the changed server's tools", async () => {
  const mkTool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true }) });
  const svcA = new MockUpstream("svcA", [mkTool("a1", "Alpha one"), mkTool("a2", "Alpha two")]);
  const svcB = new MockUpstream("svcB", [mkTool("b1", "Beta one"), mkTool("b2", "Beta two")]);
  const e = fakeEmbedder(); // no fingerprint + cache:false -> only #22 can save embeds

  const w = new Winnow({ upstreams: [svcA, svcB], embedder: e, cache: false });
  await w.init();
  assert.equal(e.embedded.length, 4, "init embeds all 4 tools");

  const svcAResultsBefore = (await w.searchTools("Alpha", { topK: 8 })).filter((h) => h.server === "svcA").map((h) => h.id);

  // Change svcB only (rewrite b2, add b3); refresh just svcB.
  e.embedded.length = 0;
  svcB.setTools([mkTool("b1", "Beta one"), mkTool("b2", "Beta two REWRITTEN"), mkTool("b3", "Beta three")]);
  await w.refresh("svcB");

  const changed = e.embedded.filter((t) => t.includes("REWRITTEN") || t.includes("Beta three"));
  assert.equal(e.embedded.length, changed.length, "refresh embeds ONLY svcB's new/changed tools");
  assert.equal(e.embedded.length, 2, "exactly the rewritten + added tool (b1 reused, svcA untouched)");
  assert.ok(!e.embedded.some((t) => t.includes("Alpha")), "no svcA tool re-embedded");

  const svcAResultsAfter = (await w.searchTools("Alpha", { topK: 8 })).filter((h) => h.server === "svcA").map((h) => h.id);
  assert.deepEqual(svcAResultsAfter, svcAResultsBefore, "unchanged svcA results identical after refreshing svcB");

  assert.ok((await w.searchTools("Beta three", { topK: 8 })).some((h) => h.id === "svcB:b3"), "new tool indexed");
  await w.close();
});

test("incremental: in-memory reuse coexists with the disk sidecar and keeps it complete", async () => {
  const dir = tmp("sidecar");
  const cache = new EmbeddingCache(dir);
  const svcA = [td("svcA", "a1", "Alpha one"), td("svcA", "a2", "Alpha two")];
  const svcB = [td("svcB", "b1", "Beta one"), td("svcB", "b2", "Beta two")];

  // Cold build on ONE instance, with the sidecar enabled (fingerprinted embedder).
  const e = fakeEmbedder("fp-inc");
  const idx = new SearchIndex(e);
  await idx.build([...svcA, ...svcB], cache);
  assert.equal(e.embedded.length, 4, "cold build embeds all 4");

  // Refresh the SAME instance with b2 rewritten -> in-memory reuse spares the other 3.
  e.embedded.length = 0;
  const svcB2 = [td("svcB", "b1", "Beta one"), td("svcB", "b2", "Beta two REWRITTEN")];
  await idx.build([...svcA, ...svcB2], cache);
  assert.equal(e.embedded.length, 1, "only the changed tool re-embeds (vecById reuse + store coexist)");
  assert.ok(e.embedded[0]!.includes("REWRITTEN"));

  // The disk sidecar must hold EVERY current tool, including the ones served from
  // memory this refresh -> a fresh instance rebuilds from disk with zero embeds.
  const fresh = fakeEmbedder("fp-inc");
  const idx2 = new SearchIndex(fresh);
  await idx2.build([...svcA, ...svcB2], cache);
  assert.equal(fresh.calls(), 0, "sidecar stayed complete: fresh instance embeds 0 from disk");
  assert.equal(fresh.embedded.length, 0);
  assert.equal(idx2.hybrid, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("incremental: combined add + remove + change in one refresh embeds exactly the add + change", async () => {
  const e = fakeEmbedder(); // no fingerprint -> in-memory path only
  const idx = new SearchIndex(e);
  const before = [
    td("svc", "keep", "Keep unchanged"),
    td("svc", "edit", "Edit me original"),
    td("svc", "gone", "Will be removed"),
  ];
  await idx.build(before);
  assert.equal(e.embedded.length, 3, "cold build embeds all 3");

  // Next set: keep unchanged, edit's text changed, gone removed, added introduced.
  e.embedded.length = 0;
  const after = [
    td("svc", "keep", "Keep unchanged"),
    td("svc", "edit", "Edit me CHANGED"),
    td("svc", "added", "Freshly added"),
  ];
  await idx.build(after);

  assert.equal(e.embedded.length, 2, "exactly the added + changed tool embed");
  assert.ok(e.embedded.some((t) => t.includes("CHANGED")), "changed tool embedded");
  assert.ok(e.embedded.some((t) => t.includes("Freshly added")), "added tool embedded");
  assert.ok(!e.embedded.some((t) => t.includes("Keep unchanged")), "unchanged tool NOT re-embedded");
  assert.ok(!(await idx.search("removed", 8)).some((h) => h.id === "svc:gone"), "removed tool gone from search");
});

test("incremental: end-to-end Winnow.refresh() (all servers) embeds only the changed server's tools", async () => {
  const mkTool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true }) });
  const svcA = new MockUpstream("svcA", [mkTool("a1", "Alpha one"), mkTool("a2", "Alpha two")]);
  const svcB = new MockUpstream("svcB", [mkTool("b1", "Beta one"), mkTool("b2", "Beta two")]);
  const e = fakeEmbedder(); // no fingerprint + cache:false -> only #22 can save embeds

  const w = new Winnow({ upstreams: [svcA, svcB], embedder: e, cache: false });
  await w.init();
  assert.equal(e.embedded.length, 4, "init embeds all 4");

  // Warm a search first, THEN reset the counter so query-embeds don't pollute the measure.
  await w.searchTools("Alpha", { topK: 8 });
  e.embedded.length = 0;

  // Change svcB only, then refresh ALL servers (no arg -> re-lists every upstream).
  svcB.setTools([mkTool("b1", "Beta one"), mkTool("b2", "Beta two REWRITTEN")]);
  await w.refresh();

  assert.equal(e.embedded.length, 1, "refresh(all) re-lists both servers but embeds only svcB's changed tool");
  assert.ok(e.embedded[0]!.includes("REWRITTEN"));
  assert.ok(!e.embedded.some((t) => t.includes("Alpha")), "no svcA tool re-embedded");
  await w.close();
});
