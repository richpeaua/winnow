import { test } from "node:test";
import assert from "node:assert/strict";
import { PooledUpstream, buildUpstreams, resolveConfig, Winnow, MockUpstream } from "../src/index.ts";
import type { UpstreamConnection } from "../src/upstream/types.ts";
import type { CallContext, ToolDef, ToolResult } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake replica that records its calls and takes `delayMs`, so a test can observe
// how PooledUpstream spreads concurrent work across replicas.
class FakeReplica implements UpstreamConnection {
  readonly server = "svc";
  readonly identity = "fake:svc";
  calls = 0;
  closed = false;
  lastCtx?: CallContext;
  constructor(public readonly id: number, private delayMs = 50) {}
  async listTools(): Promise<ToolDef[]> {
    return [{ id: "svc:t", server: "svc", name: "t", description: `from ${this.id}`, inputSchema: { type: "object" } }];
  }
  async callTool(_name: string, _args: unknown, ctx?: CallContext): Promise<ToolResult> {
    this.calls++;
    this.lastCtx = ctx;
    await sleep(this.delayMs);
    return { structuredContent: { replica: this.id } };
  }
  async close(): Promise<void> { this.closed = true; }
}

function makePool(size: number, delayMs = 50) {
  const replicas: FakeReplica[] = [];
  let next = 0;
  const pool = new PooledUpstream("svc", () => { const r = new FakeReplica(next++, delayMs); replicas.push(r); return r; }, size);
  return { pool, replicas };
}

test("pool: concurrent calls spread across replicas and run in parallel", async () => {
  const { pool, replicas } = makePool(4, 60);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => pool.callTool("t", {})));
  const dt = Date.now() - t0;
  assert.equal(replicas.length, 4, "4 replicas materialized");
  assert.deepEqual(replicas.map((r) => r.calls).sort(), [1, 1, 1, 1], "each replica handled exactly one call");
  assert.ok(dt < 180, `ran in parallel (${dt}ms), not serialized (~240ms on one connection)`);
  await pool.close();
});

test("pool: least-busy dispatch evens out a burst", async () => {
  const { pool, replicas } = makePool(4, 40);
  await Promise.all(Array.from({ length: 8 }, () => pool.callTool("t", {})));
  assert.deepEqual(replicas.map((r) => r.calls).sort((a, b) => a - b), [2, 2, 2, 2], "8 calls / 4 replicas = 2 each");
  await pool.close();
});

test("pool: forwards auth ctx and delegates identity/listTools to replica 0", async () => {
  const { pool, replicas } = makePool(3);
  assert.equal(pool.identity, "fake:svc");
  const tools = await pool.listTools();
  assert.equal(tools[0]!.description, "from 0", "listTools uses replica 0");
  await pool.callTool("t", {}, { bearer: "tok-1" });
  const handler = replicas.find((r) => r.calls > 0)!;
  assert.equal(handler.lastCtx?.bearer, "tok-1", "auth ctx reached the replica");
  await pool.close();
});

test("pool: close() closes every replica", async () => {
  const { pool, replicas } = makePool(3);
  await Promise.all(Array.from({ length: 3 }, () => pool.callTool("t", {})));
  await pool.close();
  assert.deepEqual(replicas.map((r) => r.closed), [true, true, true]);
});

test("config: poolSize > 1 wraps in PooledUpstream; default does not", () => {
  const ups = buildUpstreams(resolveConfig({
    servers: {
      pooled: { transport: "stdio", command: "x", poolSize: 3 },
      single: { transport: "stdio", command: "y" },
    },
  }));
  const byName = Object.fromEntries(ups.map((u) => [u.server, u]));
  assert.ok(byName.pooled instanceof PooledUpstream, "poolSize:3 -> pooled");
  assert.ok(!(byName.single instanceof PooledUpstream), "no poolSize -> single connection");
});

test("pool: works end-to-end through Winnow (call reaches a pooled upstream)", async () => {
  let n = 0;
  const pooled = new PooledUpstream("svc", () => new MockUpstream("svc", [
    { name: "ping", description: "ping", inputSchema: { type: "object" }, handler: () => ({ pong: ++n }) },
  ]), 2);
  const client = new Winnow({ upstreams: [pooled], cache: false });
  await client.init();
  const r = await client.call("svc:ping", {});
  assert.equal((r.output as any).pong, 1);
  await client.close();
});
