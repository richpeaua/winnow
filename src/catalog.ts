// C1 progressive-disclosure catalog: hold full defs internally, expose minimal
// entries; eager-list at init, then the client reconnects per call.
import type { CatalogEntry, Embedder, SearchHit, ToolDef } from "./types.js";
import { SearchIndex } from "./search.js";
import type { UpstreamConnection } from "./upstream/types.js";

export class Catalog {
  private defs = new Map<string, ToolDef>();
  private index: SearchIndex;
  constructor(embedder?: Embedder) {
    this.index = new SearchIndex(embedder);
  }

  get hybrid(): boolean { return this.index.hybrid; }
  get size(): number { return this.defs.size; }

  /** Eager-list every server; a server that fails to list is skipped (warn), per C1. */
  async build(upstreams: UpstreamConnection[]): Promise<{ skipped: string[] }> {
    const skipped: string[] = [];
    for (const u of upstreams) {
      try {
        for (const t of await u.listTools()) this.defs.set(t.id, t);
      } catch (e) {
        skipped.push(u.server);
        console.warn(`[mcp-winnow] server "${u.server}" failed to list tools; skipping. ${String(e).split("\n")[0]}`);
      }
    }
    await this.index.build([...this.defs.values()]);
    return { skipped };
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
