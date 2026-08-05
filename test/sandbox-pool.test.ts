import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxPool } from "../src/sandbox-pool.ts";
import type { FilteredResult } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOOLS = [{ id: "s:t", server: "s", name: "t" }];
const CALL = `const r = await mcp.s.t({}); return r.ok;`;

const okBridge = async (): Promise<FilteredResult> => ({ output: { ok: true }, tokens: 1, truncated: false });
const delayBridge = (ms: number) => async (): Promise<FilteredResult> => { await sleep(ms); return { output: { ok: true }, tokens: 1, truncated: false }; };
const hangBridge = () => new Promise<FilteredResult>(() => { /* never resolves */ });

test("pool: caps concurrent workers at maxWorkers under a burst", async () => {
  const pool = new SandboxPool(delayBridge(400), { maxWorkers: 3, maxQueue: 100 });
  const runs = Array.from({ length: 10 }, () => pool.run(CALL, TOOLS, { timeoutMs: 5000 }));
  await sleep(250); // workers spawned + busy, rest queued
  assert.ok(pool.size <= 3, `spawned ${pool.size} workers, expected <= 3`);
  const results = await Promise.all(runs);
  assert.equal(results.filter((r) => !r.isError).length, 10, "all 10 execs eventually succeed");
  assert.ok(pool.size <= 3, "never exceeded the cap");
  await pool.close();
});

test("pool: reuses workers across sequential jobs (no per-exec spawn)", async () => {
  const pool = new SandboxPool(okBridge, { maxWorkers: 2 });
  for (let i = 0; i < 5; i++) {
    const r = await pool.run(`return ${i} + 1;`, [], {});
    assert.equal(r.output, i + 1);
  }
  assert.ok(pool.size <= 2, `5 sequential jobs used ${pool.size} workers, expected <= 2`);
  await pool.close();
});

test("pool: backpressure rejects once the queue is full (never spawns past cap)", async () => {
  const pool = new SandboxPool(delayBridge(300), { maxWorkers: 1, maxQueue: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, () => pool.run(CALL, TOOLS, { timeoutMs: 5000 })));
  const rejected = results.filter((r) => r.isError && String((r.output as any).error).includes("saturated"));
  const served = results.filter((r) => !r.isError);
  assert.ok(rejected.length >= 1, "some execs rejected by backpressure");
  assert.ok(served.length >= 1, "some execs still served");
  assert.ok(pool.size <= 1, "cap held despite the burst");
  await pool.close();
});

test("pool: each job runs in a fresh context (no state leak between jobs)", async () => {
  const pool = new SandboxPool(okBridge, { maxWorkers: 1 }); // force worker reuse
  const r1 = await pool.run(`globalThis.__leak = 123; return 1;`, [], {});
  assert.equal(r1.output, 1);
  const r2 = await pool.run(`return typeof globalThis.__leak;`, [], {});
  assert.equal(r2.output, "undefined", "a global set in job 1 must not survive into job 2");
  await pool.close();
});

test("pool: soft CPU timeout errors the job but keeps the worker usable", async () => {
  const pool = new SandboxPool(okBridge, { maxWorkers: 1 });
  const r1 = await pool.run(`while (true) {} return 1;`, [], { timeoutMs: 200 });
  assert.ok(r1.isError, "runaway loop times out");
  const r2 = await pool.run(`return 42;`, [], { timeoutMs: 2000 });
  assert.equal(r2.output, 42, "the same worker serves the next job");
  await pool.close();
});

test("pool: hard backstop kills a worker wedged on a hung host call, then recovers", async () => {
  const pool = new SandboxPool(hangBridge, { maxWorkers: 1 });
  const r1 = await pool.run(CALL, TOOLS, { timeoutMs: 300 }); // blocks in Atomics.wait forever
  assert.ok(r1.isError && String((r1.output as any).error).includes("timeout"), "wedged exec hits the hard deadline");
  const r2 = await pool.run(`return 7;`, [], { timeoutMs: 2000 }); // fresh worker, no host call
  assert.equal(r2.output, 7, "pool recovered after terminating the wedged worker");
  assert.ok(pool.size <= 1);
  await pool.close();
});
