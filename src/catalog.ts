// C1 progressive-disclosure catalog: hold full defs internally, expose minimal
// entries; eager-list at init, then the client reconnects per call.
import type { CatalogEntry, Embedder, SearchHit, ToolDef } from "./types.js";
import { SearchIndex } from "./search.js";
import { CatalogCache, DEFAULT_TTL_MS } from "./cache.js";
import { EmbeddingCache } from "./embedding-cache.js";
import type { UpstreamConnection } from "./upstream/types.js";

export interface CatalogBuildOptions {
  cache?: boolean;       // default true
  cacheDir?: string;
  ttlMs?: number;        // default 1h
  now?: () => number;    // injectable clock (tests)
}

export class Catalog {
  private defs = new Map<string, ToolDef>();
  private index: SearchIndex;
  constructor(embedder?: Embedder) {
    this.index = new SearchIndex(embedder);
  }

  get hybrid(): boolean { return this.index.hybrid; }
  get size(): number { return this.defs.size; }

  /**
   * Build the catalog. With caching on (default), a server whose disk cache is
   * fresh is loaded WITHOUT connecting/listing — on a full cache hit, init makes
   * zero upstream connections. A server that fails to list falls back to a stale
   * cache entry if present, else is skipped (warn), per C1.
   */
  async build(upstreams: UpstreamConnection[], opts: CatalogBuildOptions = {}): Promise<{ skipped: string[]; fromCache: string[] }> {
    const useCache = opts.cache !== false;
    const cache = useCache ? new CatalogCache(opts.cacheDir) : null;
    const embCache = useCache ? new EmbeddingCache(opts.cacheDir) : null;
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = opts.now ?? Date.now;
    // One cold-init = one clock reading, shared by every parallel task so the
    // fresh/stale decision and cache.write timestamp are deterministic.
    const nowVal = now();
    const skipped: string[] = [];
    const fromCache: string[] = [];

    // Per-server outcome computed in parallel WITHOUT mutating shared state.
    // Each task catches its own errors so one server failing never rejects the batch.
    type Outcome =
      | { server: string; kind: "cache"; tools: ToolDef[] }
      | { server: string; kind: "live"; tools: ToolDef[] }
      | { server: string; kind: "stale"; tools: ToolDef[]; warn: string }
      | { server: string; kind: "skip"; warn: string };

    const tasks = upstreams.map(async (u): Promise<Outcome> => {
      const id = u.identity;
      // 1. Fresh cache hit -> use it, do NOT connect.
      if (cache && id) {
        const entry = cache.read(id);
        if (entry && cache.isFresh(entry, ttlMs, nowVal)) {
          return { server: u.server, kind: "cache", tools: entry.tools };
        }
      }
      // 2. Miss/expired/no-identity -> list live.
      try {
        const tools = await u.listTools();
        // Parallel disk writes go to distinct per-identity files — no contention.
        if (cache && id) cache.write(id, u.server, tools, nowVal);
        return { server: u.server, kind: "live", tools };
      } catch (e) {
        // 3. Live list failed -> degrade to a stale cache entry if we have one.
        const stale = cache && id ? cache.read(id) : null;
        if (stale) {
          return { server: u.server, kind: "stale", tools: stale.tools,
            warn: `[mcp-winnow] server "${u.server}" failed to list; using stale cache. ${String(e).split("\n")[0]}` };
        }
        return { server: u.server, kind: "skip",
          warn: `[mcp-winnow] server "${u.server}" failed to list tools; skipping. ${String(e).split("\n")[0]}` };
      }
    });

    const settled = await Promise.allSettled(tasks);

    // Drain in ORIGINAL upstreams order (not completion order): mutate shared
    // state and emit warnings here so defs insertion order and the returned
    // skipped/fromCache arrays are byte-identical to the old serial version.
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      // Tasks catch internally, but code BEFORE the try (identity getter,
      // cache.read/isFresh) runs outside it — a throw there rejects the task.
      // Keep that observable: classify it as a skip (with warning) rather than
      // silently dropping the server from both defs and skipped.
      if (s.status === "rejected") {
        const server = upstreams[i]!.server;
        skipped.push(server);
        console.warn(`[mcp-winnow] server "${server}" failed during catalog build; skipping. ${String(s.reason).split("\n")[0]}`);
        continue;
      }
      const o = s.value;
      switch (o.kind) {
        case "cache":
          for (const t of o.tools) this.defs.set(t.id, t);
          fromCache.push(o.server);
          break;
        case "live":
          for (const t of o.tools) this.defs.set(t.id, t);
          break;
        case "stale":
          for (const t of o.tools) this.defs.set(t.id, t);
          fromCache.push(o.server);
          console.warn(o.warn);
          break;
        case "skip":
          skipped.push(o.server);
          console.warn(o.warn);
          break;
      }
    }
    await this.index.build([...this.defs.values()], embCache);
    return { skipped, fromCache };
  }

  /** Re-list one server, replace its defs, rebuild the index, refresh its cache. */
  async refresh(upstream: UpstreamConnection, opts: CatalogBuildOptions = {}): Promise<void> {
    const tools = await upstream.listTools();
    for (const [id, def] of this.defs) if (def.server === upstream.server) this.defs.delete(id);
    for (const t of tools) this.defs.set(t.id, t);
    const embCache = opts.cache !== false ? new EmbeddingCache(opts.cacheDir) : null;
    if (opts.cache !== false && upstream.identity) {
      new CatalogCache(opts.cacheDir).write(upstream.identity, upstream.server, tools, (opts.now ?? Date.now)());
    }
    // Reindex over all defs; the sidecar keeps unchanged servers as hits, so only
    // this server's (new/changed) tools are re-embedded.
    await this.index.build([...this.defs.values()], embCache);
  }

  search(query: string, topK = 8): Promise<SearchHit[]> {
    return this.index.search(query, topK);
  }

  /** Full schema(s) on demand — the only heavy per-tool payload. */
  loadTool(ids: string | string[]): ToolDef[] {
    const list = Array.isArray(ids) ? ids : [ids];
    return list.map((id) => {
      const def = this.defs.get(id);
      if (!def) throw new Error(`unknown tool id: ${id}`);
      return def;
    });
  }

  /** All tools for a server — the low-score escape hatch (browse instead of guess). */
  listTools(server?: string): CatalogEntry[] {
    return [...this.defs.values()]
      .filter((t) => !server || t.server === server)
      .map((t) => ({ id: t.id, name: t.name, summary: (t.description.split(". ")[0] ?? t.description).slice(0, 100), server: t.server }));
  }

  has(id: string): boolean { return this.defs.has(id); }
}
