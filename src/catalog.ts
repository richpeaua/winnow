// C1 progressive-disclosure catalog: hold full defs internally, expose minimal
// entries; eager-list at init, then the client reconnects per call.
import type { CatalogEntry, Embedder, SearchHit, ToolDef } from "./types.js";
import { SearchIndex } from "./search.js";
import { CatalogCache, DEFAULT_TTL_MS } from "./cache.js";
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
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = opts.now ?? Date.now;
    const skipped: string[] = [];
    const fromCache: string[] = [];

    for (const u of upstreams) {
      const id = u.identity;
      // 1. Fresh cache hit -> use it, do NOT connect.
      if (cache && id) {
        const entry = cache.read(id);
        if (entry && cache.isFresh(entry, ttlMs, now())) {
          for (const t of entry.tools) this.defs.set(t.id, t);
          fromCache.push(u.server);
          continue;
        }
      }
      // 2. Miss/expired/no-identity -> list live.
      try {
        const tools = await u.listTools();
        for (const t of tools) this.defs.set(t.id, t);
        if (cache && id) cache.write(id, u.server, tools, now());
      } catch (e) {
        // 3. Live list failed -> degrade to a stale cache entry if we have one.
        const stale = cache && id ? cache.read(id) : null;
        if (stale) {
          for (const t of stale.tools) this.defs.set(t.id, t);
          fromCache.push(u.server);
          console.warn(`[mcp-winnow] server "${u.server}" failed to list; using stale cache. ${String(e).split("\n")[0]}`);
        } else {
          skipped.push(u.server);
          console.warn(`[mcp-winnow] server "${u.server}" failed to list tools; skipping. ${String(e).split("\n")[0]}`);
        }
      }
    }
    await this.index.build([...this.defs.values()]);
    return { skipped, fromCache };
  }

  /** Re-list one server, replace its defs, rebuild the index, refresh its cache. */
  async refresh(upstream: UpstreamConnection, opts: CatalogBuildOptions = {}): Promise<void> {
    const tools = await upstream.listTools();
    for (const [id, def] of this.defs) if (def.server === upstream.server) this.defs.delete(id);
    for (const t of tools) this.defs.set(t.id, t);
    if (opts.cache !== false && upstream.identity) {
      new CatalogCache(opts.cacheDir).write(upstream.identity, upstream.server, tools, (opts.now ?? Date.now)());
    }
    await this.index.build([...this.defs.values()]);
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
