// Worker-backed local embedder (issue #5). Returns an `Embedder` whose inference
// runs in a dedicated worker thread, so hybrid search embedding never blocks the
// main event loop (critical when one gateway serves many agents). Backed by the
// optional @huggingface/transformers dep; if it's unavailable the embed rejects
// and search degrades to lexical-only. Pass to `new Winnow({ embedder })`.
import { Worker } from "node:worker_threads";
import type { Embedder } from "./types.js";
import { fingerprintFor } from "./embedding-cache.js";

export interface LocalEmbedderOptions {
  /** HF model id (Transformers.js). Default "Xenova/all-MiniLM-L6-v2". */
  model?: string;
  /** Pooling strategy. Default "mean". */
  pooling?: "mean" | "cls" | "none";
  /** L2-normalize outputs (so dot product == cosine). Default true. */
  normalize?: boolean;
  /** Optional quantization dtype (e.g. "q8") to shrink/speed the model. */
  dtype?: string;
}

/** An Embedder that owns a worker thread; close() terminates it. */
export type ClosableEmbedder = Required<Pick<Embedder, "close">> & Embedder;

/** Create a worker-thread-backed embedder. The worker (and model) load lazily on
 *  the first embed; call `close()` (or `Winnow.close()`) to terminate it. */
export function localEmbedder(opts: LocalEmbedderOptions = {}): ClosableEmbedder {
  const options = {
    model: opts.model ?? "Xenova/all-MiniLM-L6-v2",
    pooling: opts.pooling ?? "mean",
    normalize: opts.normalize ?? true,
    dtype: opts.dtype,
  };
  // Plain .mjs worker so it loads natively across Node versions (see sandbox-pool).
  const workerUrl = new URL("./embedder-worker.mjs", import.meta.url);

  let worker: Worker | null = null;
  let seq = 0;
  interface FlatVectors { data: Float32Array; dim: number; }
  const pending = new Map<number, { resolve: (v: FlatVectors) => void; reject: (e: Error) => void }>();

  const rejectAll = (err: Error) => { for (const p of pending.values()) p.reject(err); pending.clear(); };

  const ensure = (): Worker => {
    if (worker) return worker;
    const w = new Worker(workerUrl, { execArgv: [], workerData: { options } });
    w.on("message", (msg: any) => {
      const p = pending.get(msg?.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === "result") p.resolve({ data: msg.data as Float32Array, dim: msg.dim as number });
      else p.reject(new Error(msg.message || "embed failed"));
    });
    w.on("error", (e) => { rejectAll(e instanceof Error ? e : new Error(String(e))); });
    w.on("exit", (code) => {
      if (worker === w) worker = null;
      if (code !== 0) rejectAll(new Error(`embedder worker exited (code ${code})`));
    });
    worker = w;
    return w;
  };

  return {
    // Stable id of this embedding config, so the on-disk vector sidecar knows
    // which vectors are interchangeable (issue #21).
    fingerprint: fingerprintFor(options),

    // Fast path: a contiguous Float32Array (N*dim) transferred from the worker,
    // never a number[][]. This is what SearchIndex uses so vectors flow flat all
    // the way to the dot-product loop and the sidecar.
    async embedFlat(texts: string[]): Promise<FlatVectors> {
      if (!texts.length) return { data: new Float32Array(0), dim: 0 };
      const w = ensure();
      const id = ++seq;
      return new Promise<FlatVectors>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ type: "embed", id, texts });
      });
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const { data, dim } = await this.embedFlat!(texts);
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i++) out.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
      return out;
    },

    async close(): Promise<void> {
      const w = worker;
      worker = null;
      rejectAll(new Error("embedder closed"));
      if (w) await w.terminate();
    },
  };
}
