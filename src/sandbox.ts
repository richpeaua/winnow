// X1 code-execution sandbox — synchronous QuickJS-WASM inside a worker_thread.
// Host MCP calls are bridged synchronously via Atomics: the worker blocks on
// Atomics.wait while the main thread performs the async (filtered) call and
// writes the result into a SharedArrayBuffer. This avoids the asyncify job-pump
// hazards entirely, and the worker gives hard timeout/memory isolation.
// Capability-injected: the sandbox reaches only __mcpCall + a return channel;
// no ambient fs/net/env/timers. See docs/DESIGN.md §6.
//
// Concurrency is managed by SandboxPool (bounded workers + queue). This module
// keeps the one-shot `runSandbox` entrypoint as a thin shim over a size-1 pool
// for callers/tests that just want to run a single exec.
import { approxTokens } from "./filter.js";
import { SandboxPool, type ExecOpts } from "./sandbox-pool.js";
import type { FilteredResult, TokenCounter } from "./types.js";

export type { ExecOpts } from "./sandbox-pool.js";
export { SandboxPool, type SandboxPoolOptions } from "./sandbox-pool.js";

export interface SandboxBridge {
  call(id: string, args: unknown): Promise<FilteredResult>;
  tools: Array<{ id: string; server: string; name: string }>;
}

/** Run a single exec in a throwaway size-1 pool. Prefer a shared SandboxPool for
 *  concurrent workloads (it bounds workers/memory); this is the convenience path. */
export async function runSandbox(
  code: string,
  bridge: SandboxBridge,
  opts: ExecOpts = {},
  count: TokenCounter = approxTokens
): Promise<FilteredResult> {
  const pool = new SandboxPool((id, args) => bridge.call(id, args), { maxWorkers: 1, maxQueue: 1 }, count);
  try {
    return await pool.run(code, bridge.tools, opts);
  } finally {
    await pool.close();
  }
}
