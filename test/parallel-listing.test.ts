// Issue #25: Catalog.build() lists servers in parallel. These tests lock in
// (a) deterministic drain order = upstream order regardless of completion order,
// (b) unchanged per-server semantics, (c) the wall-time win over serial listing.
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
  const d = path.join(os.tmpdir(), `winnow-parallel-${tag}-${process.pid}-${Date.now()}`);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

test("parallel: drain order == upstream order even when a MIDDLE server finishes last", async () => {
  const dir = tmp("order");
  // Seed a fresh cache for "cached" so its task short-circuits (no connect).
  await new Winnow({ upstreams: [new MockUpstream("cached", [tool("c1", "Cached tool")])], cacheDir: dir }).init();

  // Order: cached (fresh hit, instant), mid (live, SLOWEST), fast (live), broken (skip).
  const cached = new Counting(new MockUpstream("cached", [tool("c1", "Cached tool")]));
  const mid = new MockUpstream("mid", [tool("m1", "Mid tool")], 120); // slowest -> completes last
  const fast = new MockUpstream("fast", [tool("f1", "Fast tool")], 0);
  const broken = new Counting(new MockUpstream("broken", [tool("b1", "Broken tool")]), true);

  const w = new Winnow({ upstreams: [cached, mid, fast, broken], cacheDir: dir, cacheTtlMs: 60_000 });
  const info = await w.init();

  assert.equal(cached.listCount, 0, "fresh cache hit does NOT connect/list");
  assert.deepEqual(info.fromCache, ["cached"], "fromCache in upstream order");
  assert.deepEqual(info.skipped, ["broken"], "failing-with-no-cache is skipped");

  // defs iteration (via public listTools) reflects insertion = upstream order,
  // NOT completion order (mid finishes last but sits in the middle).
  assert.deepEqual(w.listTools().map((t) => t.id), ["cached:c1", "mid:m1", "fast:f1"]);
  await w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parallel: stale-fallback on list failure (warns, keeps cached tools)", async () => {
  const dir = tmp("stale");
  await new Winnow({ upstreams: [new MockUpstream("svc", [tool("alpha", "Alpha")])], cacheDir: dir }).init(); // seed cache
  const failing = new Counting(new MockUpstream("svc", [tool("alpha", "Alpha")]), true);
  const i = await new Winnow({ upstreams: [failing], cacheDir: dir, cacheTtlMs: 0 }).init();
  assert.equal(failing.listCount, 1, "attempted a live list");
  assert.deepEqual(i.skipped, [], "not skipped — fell back to stale cache");
  assert.deepEqual(i.fromCache, ["svc"]);
  assert.equal(i.tools, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parallel: cold init wall-time ~ slowest server, not the sum (5 x 200ms)", async () => {
  const N = 5, delay = 200;
  const upstreams = Array.from({ length: N }, (_, k) => new MockUpstream(`s${k}`, [tool(`t${k}`, `Tool ${k}`)], delay));
  const w = new Winnow({ upstreams, cache: false }); // cold, no cache reuse
  const start = Date.now();
  const info = await w.init();
  const elapsed = Date.now() - start;
  assert.equal(info.tools, N, "all servers listed");
  // Relative bound: parallel is ~1*delay (200ms), serial would be ~N*delay (1000ms).
  // (N-1)*delay = 800ms sits cleanly between them and tolerates ~600ms of CI noise.
  const bound = (N - 1) * delay;
  assert.ok(elapsed < bound, `expected parallel init < ${bound}ms, got ${elapsed}ms (serial would be ~${N * delay}ms)`);
  await w.close();
});

test("parallel: a MIDDLE server failing does not drop or reorder later live servers", async () => {
  const dir = tmp("midfail");
  await new Winnow({ upstreams: [new MockUpstream("cached", [tool("c1", "Cached")])], cacheDir: dir }).init(); // seed

  // broken is NOT last — a failure in the middle must not disturb the tail.
  const cached = new MockUpstream("cached", [tool("c1", "Cached")]);
  const broken = new Counting(new MockUpstream("broken", [tool("b1", "Broken")]), true);
  const mid = new MockUpstream("mid", [tool("m1", "Mid")], 40);
  const fast = new MockUpstream("fast", [tool("f1", "Fast")], 0);

  const w = new Winnow({ upstreams: [cached, broken, mid, fast], cacheDir: dir, cacheTtlMs: 60_000 });
  const info = await w.init();

  assert.deepEqual(info.skipped, ["broken"], "middle failure is skipped");
  assert.deepEqual(info.fromCache, ["cached"], "cached hit preserved");
  // Tail live servers still land in defs, in upstream order, broken omitted.
  assert.deepEqual(w.listTools().map((t) => t.id), ["cached:c1", "mid:m1", "fast:f1"]);
  await w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parallel: a pre-try throw (identity getter) is skipped with a warning, not silently dropped", async () => {
  // identity is read BEFORE the task's try block; a throw there rejects the task
  // promise. The drain must classify it as a skip, keeping it observable.
  const exploding: UpstreamConnection = {
    server: "exploder",
    get identity(): string { throw new Error("identity boom"); },
    async listTools() { return []; },
    async callTool() { return { content: [] }; },
    async close() {},
  };
  const good = new MockUpstream("good", [tool("g1", "Good")]);
  const dir = tmp("pretry");
  const w = new Winnow({ upstreams: [exploding, good], cacheDir: dir });
  const info = await w.init();
  assert.deepEqual(info.skipped, ["exploder"], "pre-try throw lands in skipped");
  assert.deepEqual(w.listTools().map((t) => t.id), ["good:g1"], "healthy server unaffected");
  await w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
