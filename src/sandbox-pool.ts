// Bounded sandbox worker pool (issue #4). Replaces per-exec worker spawn with a
// capped set of persistent workers + a FIFO queue with backpressure. Each worker
// inits QuickJS once and runs one job at a time in a FRESH context (isolation),
// so memory is bounded at maxWorkers × (SAB + heap) regardless of agent count.
//
// Two-layer timeout: the worker's QuickJS interrupt handler catches CPU-bound
// runaway (soft, worker survives); a main-side deadline is the hard backstop for
// a worker wedged in Atomics.wait on a hung host call (terminate + respawn).
import os from "node:os";
import { Worker } from "node:worker_threads";
import { filterResult, approxTokens } from "./filter.js";
import type { FilteredResult, TokenCounter } from "./types.js";

export interface ExecOpts {
  timeoutMs?: number;
  memoryMb?: number;
  maxTokens?: number;
}

export interface SandboxPoolOptions {
  /** Max concurrent workers. Default max(1, min(4, cpus-1)). */
  maxWorkers?: number;
  /** Max queued (not-yet-running) jobs before backpressure rejects. Default maxWorkers*8. */
  maxQueue?: number;
  /** Reject a job that waits longer than this in the queue. Default 10_000ms. */
  queueTimeoutMs?: number;
}

export type BridgeCall = (id: string, args: unknown) => Promise<FilteredResult>;
export type ToolFacade = Array<{ id: string; server: string; name: string }>;

const BRIDGE_BYTES = 32 * 1024 * 1024; // max size of a single bridged result
const HARD_KILL_GRACE_MS = 250; // over the soft deadline before we terminate a wedged worker

interface Job {
  code: string;
  tools: ToolFacade;
  opts: ExecOpts;
  resolve: (r: FilteredResult) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
}

interface PooledWorker {
  worker: Worker;
  ctrl: Int32Array;
  data: Uint8Array;
  ready: boolean;
  busy: boolean;
  job?: Job;
  deadline?: ReturnType<typeof setTimeout>;
}

export class SandboxPool {
  private workers: PooledWorker[] = [];
  private queue: Job[] = [];
  private closed = false;
  private readonly maxWorkers: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;

  constructor(
    private bridge: BridgeCall,
    opts: SandboxPoolOptions = {},
    private count: TokenCounter = approxTokens
  ) {
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? Math.min(4, Math.max(1, os.cpus().length - 1)));
    this.maxQueue = Math.max(1, opts.maxQueue ?? this.maxWorkers * 8);
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 10_000;
  }

  /** Live worker count — for tests/observability (spawned, not yet reaped). */
  get size(): number { return this.workers.length; }

  private errResult(m: string): FilteredResult {
    return { output: { error: m }, tokens: this.count(m), truncated: false, isError: true };
  }

  /** Run one exec. Never rejects: overflow/timeout/crash all resolve as an isError result. */
  run(code: string, tools: ToolFacade, opts: ExecOpts = {}): Promise<FilteredResult> {
    if (this.closed) return Promise.resolve(this.errResult("sandbox pool closed"));
    if (this.queue.length >= this.maxQueue) {
      return Promise.resolve(this.errResult(`sandbox pool saturated (queue full: ${this.maxQueue})`));
    }
    return new Promise<FilteredResult>((resolve) => {
      const job: Job = { code, tools, opts, resolve };
      job.queueTimer = setTimeout(() => {
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); resolve(this.errResult(`exec queued longer than ${this.queueTimeoutMs}ms`)); }
      }, this.queueTimeoutMs);
      this.queue.push(job);
      this.drain();
    });
  }

  private takeIdle(): PooledWorker | undefined {
    return this.workers.find((w) => w.ready && !w.busy);
  }

  private drain(): void {
    while (this.queue.length) {
      const w = this.takeIdle();
      if (!w) {
        if (this.workers.length < this.maxWorkers) this.spawn(); // async; re-drains on "ready"
        return;
      }
      this.dispatch(w, this.queue.shift()!);
    }
  }

  private dispatch(w: PooledWorker, job: Job): void {
    clearTimeout(job.queueTimer);
    w.busy = true;
    w.job = job;
    const timeoutMs = job.opts.timeoutMs ?? 5000;
    w.deadline = setTimeout(() => this.onDeadline(w), timeoutMs + HARD_KILL_GRACE_MS);
    w.worker.postMessage({ type: "job", code: job.code, tools: job.tools, memoryMb: job.opts.memoryMb ?? 64, timeoutMs });
  }

  private finishJob(w: PooledWorker, result: FilteredResult): void {
    const job = w.job;
    if (!job) return;
    clearTimeout(w.deadline);
    w.deadline = undefined;
    w.job = undefined;
    w.busy = false;
    job.resolve(result);
    this.drain();
  }

  /** Hard backstop: a worker past its deadline (e.g. wedged in Atomics.wait on a
   *  hung host call, where the soft interrupt can't fire) is terminated + replaced. */
  private onDeadline(w: PooledWorker): void {
    const job = w.job;
    const timeoutMs = job?.opts.timeoutMs ?? 5000;
    this.killWorker(w);
    if (job) job.resolve(this.errResult(`exec timeout after ${timeoutMs}ms`));
    this.drain();
  }

  private killWorker(w: PooledWorker): void {
    const i = this.workers.indexOf(w);
    if (i >= 0) this.workers.splice(i, 1);
    clearTimeout(w.deadline);
    void w.worker.terminate();
  }

  private async handleCall(w: PooledWorker, msg: { id: string; args: unknown }): Promise<void> {
    let payload: string;
    try {
      const r = await this.bridge(msg.id, msg.args);
      payload = JSON.stringify({ output: r.output, isError: !!r.isError });
    } catch (e) {
      payload = JSON.stringify({ output: String((e as Error)?.message ?? e), isError: true });
    }
    let bytes = Buffer.from(payload, "utf8");
    if (bytes.length > w.data.length) bytes = Buffer.from(JSON.stringify({ output: "bridged result too large", isError: true }), "utf8");
    // The worker may already be gone (terminated by the deadline) — writes to a
    // dead SAB view are harmless, so no guard is needed.
    w.data.set(bytes, 0);
    Atomics.store(w.ctrl, 1, bytes.length);
    Atomics.store(w.ctrl, 0, 1);
    Atomics.notify(w.ctrl, 0);
  }

  // The worker is a plain .mjs so it loads natively across Node versions (a TS
  // loader does not reliably apply to a Worker entry on Node 20). execArgv: []
  // avoids inheriting the parent's flags (e.g. the test runner's --test).
  private spawn(): void {
    const workerUrl = new URL("./sandbox-worker.mjs", import.meta.url);
    const sab = new SharedArrayBuffer(16 + BRIDGE_BYTES);
    const worker = new Worker(workerUrl, { execArgv: [], workerData: { sab } });
    const w: PooledWorker = { worker, ctrl: new Int32Array(sab, 0, 4), data: new Uint8Array(sab, 16), ready: false, busy: false };
    this.workers.push(w);

    worker.on("message", (msg: any) => {
      if (msg?.type === "ready") { w.ready = true; this.drain(); return; }
      if (msg?.type === "call") { void this.handleCall(w, msg); return; }
      if (msg?.type === "done") { this.finishJob(w, filterResult({ structuredContent: msg.value }, { maxTokens: w.job?.opts.maxTokens }, this.count)); return; }
      if (msg?.type === "error") { this.finishJob(w, this.errResult(msg.message)); return; }
    });
    const onDead = (err: Error) => {
      const startupFailure = !w.ready; // never reached "ready" -> the worker can't start
      const job = w.job;
      this.killWorker(w);
      if (job) job.resolve(this.errResult(err.message));
      // A worker that dies before ever running is broken (bad env, missing dep):
      // surface it to queued jobs instead of respawning forever into a timeout.
      if (startupFailure) this.failQueue(err); else this.drain();
    };
    worker.on("error", (e) => onDead(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", (code) => { if (this.workers.includes(w)) onDead(new Error(`sandbox worker exited (code ${code})`)); });
  }

  private failQueue(err: Error): void {
    const jobs = this.queue;
    this.queue = [];
    for (const job of jobs) { clearTimeout(job.queueTimer); job.resolve(this.errResult(`sandbox worker failed to start: ${err.message}`)); }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue) { clearTimeout(job.queueTimer); job.resolve(this.errResult("sandbox pool closed")); }
    this.queue = [];
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers.map((w) => { clearTimeout(w.deadline); return w.worker.terminate(); }));
  }
}
