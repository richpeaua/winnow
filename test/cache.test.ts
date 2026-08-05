import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Winnow, MockUpstream } from "../src/index.ts";
import type { UpstreamConnection } from "../src/index.ts";

const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true }) });

/** Wraps an upstream to count listTools calls (and optionally throw). */
class Counting implements UpstreamConnection {
  listCount = 0;
  constructor(private inner: UpstreamConnection, private throwOnList = false) {}
  get server() { return this.inner.server; }
  get identity() { return this.inner.identity; }
  async listTools() { this.listCount++; if (this.throwOnList) throw new Error("list failed"); return this.inner.listTools(); }
  callTool(n: string, a: unknown) { return this.inner.callTool(n, a); }
  close() { return this.inner.close(); }
}

function tmp(tag: string): string {
  const d = path.join(os.tmpdir(), `winnow-cache-${tag}-${process.pid}-${Date.now()}`);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

test("cache: a second process reuses a warm cache without listing (zero connections)", async () => {
  const dir = tmp("warm");
  const a = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha tool")]));
  const w1 = new Winnow({ upstreams: [a], cacheDir: dir });
  const i1 = await w1.init();
  assert.equal(a.listCount, 1, "first run lists");
  assert.deepEqual(i1.fromCache, [], "first run is not from cache");

  const b = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha tool")])); // same identity
  const w2 = new Winnow({ upstreams: [b], cacheDir: dir });
  const i2 = await w2.init();
  assert.equal(b.listCount, 0, "second run does NOT list — served from cache");
  assert.deepEqual(i2.fromCache, ["svc"]);
  assert.ok((await w2.searchTools("alpha")).some((h) => h.id === "svc:alpha"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cache: false is ephemeral — always lists, writes nothing", async () => {
  const dir = tmp("ephemeral");
  const a = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]));
  await new Winnow({ upstreams: [a], cache: false, cacheDir: dir }).init();
  const b = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]));
  await new Winnow({ upstreams: [b], cache: false, cacheDir: dir }).init();
  assert.equal(a.listCount, 1);
  assert.equal(b.listCount, 1, "no reuse when cache disabled");
  assert.equal(fs.existsSync(dir), false, "no cache dir written");
});

test("cache: an expired entry (ttl 0) is re-listed", async () => {
  const dir = tmp("expired");
  const a = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]));
  await new Winnow({ upstreams: [a], cacheDir: dir }).init(); // writes cache
  const b = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]));
  const i = await new Winnow({ upstreams: [b], cacheDir: dir, cacheTtlMs: 0 }).init();
  assert.equal(b.listCount, 1, "expired -> re-listed");
  assert.deepEqual(i.fromCache, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cache: live-list failure degrades to a stale cache entry", async () => {
  const dir = tmp("degrade");
  await new Winnow({ upstreams: [new MockUpstream("svc", [tool("alpha", "Alpha")])], cacheDir: dir }).init(); // seed cache
  const failing = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]), true);
  const i = await new Winnow({ upstreams: [failing], cacheDir: dir, cacheTtlMs: 0 }).init();
  assert.equal(failing.listCount, 1, "attempted a live list");
  assert.deepEqual(i.skipped, [], "not skipped — fell back to cache");
  assert.deepEqual(i.fromCache, ["svc"]);
  assert.equal(i.tools, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("watch: a live tools/list_changed auto-refreshes the catalog (no manual refresh)", async () => {
  const mock = new MockUpstream("svc", [tool("alpha", "Alpha tool")]);
  const w = new Winnow({ upstreams: [mock], cache: false, watch: true });
  const info = await w.init();
  assert.deepEqual(info.watching, ["svc"], "watch registered");
  assert.ok((await w.searchTools("alpha")).some((h) => h.id === "svc:alpha"));

  let fired = 0;
  w.on("toolsChanged", () => { fired++; });

  // Server changes its tool set and signals it — no manual refresh() call.
  mock.setTools([tool("gamma", "Gamma tool")]);
  await mock.emitToolsChanged();

  assert.equal(fired, 1, "toolsChanged fired from the subscription");
  assert.ok((await w.searchTools("gamma")).some((h) => h.id === "svc:gamma"), "new tool auto-indexed");
  assert.ok(!w.listTools("svc").some((t) => t.id === "svc:alpha"), "old tool gone");
  await w.close();
});

test("watch: close() unsubscribes (no more auto-refresh)", async () => {
  const mock = new MockUpstream("svc", [tool("alpha", "Alpha")]);
  const w = new Winnow({ upstreams: [mock], cache: false, watch: true });
  await w.init();
  let fired = 0;
  w.on("toolsChanged", () => { fired++; });
  await w.close();
  mock.setTools([tool("beta", "Beta")]);
  await mock.emitToolsChanged();
  assert.equal(fired, 0, "no callbacks after close");
});

test("refresh: picks up a changed tool set and fires toolsChanged", async () => {
  const mock = new MockUpstream("svc", [tool("alpha", "Alpha tool")]);
  const w = new Winnow({ upstreams: [mock], cache: false });
  await w.init();
  assert.ok((await w.searchTools("alpha")).some((h) => h.id === "svc:alpha"));

  let fired = false;
  w.on("toolsChanged", () => { fired = true; });
  mock.setTools([tool("beta", "Beta tool")]);
  await w.refresh("svc");

  assert.ok(fired, "toolsChanged fired");
  const hits = await w.searchTools("beta");
  assert.ok(hits.some((h) => h.id === "svc:beta"), "new tool indexed");
  assert.ok(!w.listTools("svc").some((t) => t.id === "svc:alpha"), "old tool gone");
  await w.close();
});
