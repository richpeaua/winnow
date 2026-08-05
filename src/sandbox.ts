// X1 code-execution sandbox — synchronous QuickJS-WASM inside a worker_thread.
// Host MCP calls are bridged synchronously via Atomics: the worker blocks on
// Atomics.wait while the main thread performs the async (filtered) call and
// writes the result into a SharedArrayBuffer. This avoids the asyncify job-pump
// hazards entirely, and the worker gives hard timeout/memory isolation.
// Capability-injected: the sandbox reaches only __mcpCall + a return channel;
// no ambient fs/net/env/timers. See docs/DESIGN.md §6.
import { Worker } from "node:worker_threads";
import { filterResult, approxTokens } from "./filter.ts";
import type { FilteredResult, TokenCounter } from "./types.ts";

export interface ExecOpts {
  timeoutMs?: number;
  memoryMb?: number;
  maxTokens?: number;
}

export interface SandboxBridge {
  call(id: string, args: unknown): Promise<FilteredResult>;
  tools: Array<{ id: string; server: string; name: string }>;
}

const BRIDGE_BYTES = 32 * 1024 * 1024; // max size of a single bridged result

/** Keep only loader-related execArgv (e.g. tsx's `--import`) so the worker can
 *  load .ts, while dropping runtime flags Worker rejects (the test runner adds many). */
function loaderExecArgv(): string[] {
  const src = process.execArgv;
  const keep: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i]!;
    if (/^--(import|loader|experimental-loader|require)(=.*)?$/.test(a)) {
      keep.push(a);
      const next = src[i + 1];
      if (!a.includes("=") && next && !next.startsWith("-")) keep.push(src[++i]!);
    }
  }
  return keep;
}

export async function runSandbox(
  code: string,
  bridge: SandboxBridge,
  opts: ExecOpts = {},
  count: TokenCounter = approxTokens
): Promise<FilteredResult> {
  const workerUrl = new URL("./sandbox-worker.ts", import.meta.url);
  const sab = new SharedArrayBuffer(16 + BRIDGE_BYTES);
  const ctrl = new Int32Array(sab, 0, 4); // [0]=flag, [1]=length
  const data = new Uint8Array(sab, 16);
  const timeoutMs = opts.timeoutMs ?? 5000;

  return await new Promise<FilteredResult>((resolve) => {
    let done = false;
    const finish = (r: FilteredResult) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); resolve(r); };
    const errResult = (m: string): FilteredResult => ({ output: { error: m }, tokens: count(m), truncated: false, isError: true });

    const worker = new Worker(workerUrl, {
      execArgv: loaderExecArgv(),
      workerData: { code, sab, tools: bridge.tools, memoryMb: opts.memoryMb ?? 64, timeoutMs },
    });
    const timer = setTimeout(() => finish(errResult(`exec timeout after ${timeoutMs}ms`)), timeoutMs);

    worker.on("message", async (msg: any) => {
      if (msg?.type === "call") {
        let payload: string;
        try {
          const r = await bridge.call(msg.id, msg.args);
          payload = JSON.stringify({ output: r.output, isError: !!r.isError });
        } catch (e) {
          payload = JSON.stringify({ output: String((e as Error)?.message ?? e), isError: true });
        }
        let bytes = Buffer.from(payload, "utf8");
        if (bytes.length > data.length) bytes = Buffer.from(JSON.stringify({ output: "bridged result too large", isError: true }), "utf8");
        data.set(bytes, 0);
        Atomics.store(ctrl, 1, bytes.length);
        Atomics.store(ctrl, 0, 1);
        Atomics.notify(ctrl, 0);
      } else if (msg?.type === "done") {
        finish(filterResult({ structuredContent: msg.value }, { maxTokens: opts.maxTokens }, count));
      } else if (msg?.type === "error") {
        finish(errResult(msg.message));
      }
    });
    worker.on("error", (e) => finish(errResult(String(e?.message ?? e))));
    worker.on("exit", (c) => { if (!done && c !== 0) finish(errResult(`sandbox worker exited (code ${c})`)); });
  });
}
