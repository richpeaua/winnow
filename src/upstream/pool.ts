// Upstream connection pool (issue #7). At scale the shape is fan-in: many agents
// -> one shared Winnow -> ONE connection per upstream. JSON-RPC multiplexes by id
// so the client never serializes, but a single-threaded upstream subprocess
// processes calls sequentially, so the fleet queues behind one server instance.
//
// PooledUpstream holds N lazily-connected replicas of an upstream and dispatches
// each call to the LEAST-BUSY replica, giving a single-threaded server N parallel
// workers. Transport-agnostic: it wraps any UpstreamConnection factory (stdio or
// http). Replicas connect lazily, so idle cost stays at one connection; extra
// replicas spin up only under concurrency and are reused after.
import type { CallContext, ToolDef, ToolResult } from "../types.js";
import type { UpstreamConnection } from "./types.js";

export class PooledUpstream implements UpstreamConnection {
  private replicas: UpstreamConnection[];
  private inFlight: number[];
  /** Present only when the underlying upstream supports it (delegates to replica 0). */
  watch?: (onChanged: () => void | Promise<void>) => Promise<() => void>;

  /** @param factory builds one replica connection; called `size` times.
   *  @param size number of replicas (>= 1). */
  constructor(public readonly server: string, factory: () => UpstreamConnection, size: number) {
    const n = Math.max(1, Math.floor(size));
    this.replicas = Array.from({ length: n }, factory);
    this.inFlight = new Array(n).fill(0);
    const first = this.replicas[0]!;
    // listTools/watch use replica 0 — the catalog is server-wide, not per-replica.
    if (first.watch) this.watch = (cb) => first.watch!(cb);
  }

  // Same identity a single connection would produce, so the catalog cache key is
  // unaffected by pool size (replicas are interchangeable clones of one server).
  get identity(): string | undefined { return this.replicas[0]!.identity; }

  listTools(): Promise<ToolDef[]> { return this.replicas[0]!.listTools(); }

  async callTool(name: string, args: unknown, ctx?: CallContext): Promise<ToolResult> {
    const i = this.pickLeastBusy();
    this.inFlight[i]!++; // synchronous before the await, so concurrent calls spread across replicas
    try {
      return await this.replicas[i]!.callTool(name, args, ctx);
    } finally {
      this.inFlight[i]!--;
    }
  }

  private pickLeastBusy(): number {
    let best = 0;
    for (let i = 1; i < this.inFlight.length; i++) {
      if (this.inFlight[i]! < this.inFlight[best]!) best = i;
    }
    return best;
  }

  async close(): Promise<void> {
    await Promise.all(this.replicas.map((r) => r.close()));
  }
}
