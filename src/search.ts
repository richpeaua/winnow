// S1 tool-search: Orama BM25 (always on, the headless floor) + optional
// embedder (semantic) fused with RRF. Degrades to lexical-only when no
// embedder is available. Validated in bench/recall.js (hybrid 100% recall@8,
// lexical 88%) -> callers should pre-provision an embedder for headless.
import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import type { Embedder, SearchHit, ToolDef } from "./types.js";
import { embedTextHash, type EmbeddingCache } from "./embedding-cache.js";

function indexText(t: ToolDef): string {
  const props = (t.inputSchema as any)?.properties ?? {};
  const params = Object.entries(props).map(([k, v]: [string, any]) => `${k} ${v?.description ?? ""}`).join(" ");
  const aliases = (t.aliases ?? []).join(" ");
  return `${t.server} ${t.name.replace(/_/g, " ")} ${t.description} ${aliases} ${params}`;
}

function summary(t: ToolDef): string {
  return (t.description.split(". ")[0] ?? t.description).slice(0, 100);
}

/** Dot product of a query vector against row `row` of a flat (N*dim) matrix.
 *  Vectors are L2-normalized at the source, so dot == cosine. No `?? 0` guard:
 *  the flat layout has exactly `dim` lanes per row by construction. */
function dot(q: Float32Array, m: Float32Array, row: number, dim: number): number {
  let s = 0;
  const off = row * dim;
  for (let i = 0; i < dim; i++) s += q[i]! * m[off + i]!;
  return s;
}

export class SearchIndex {
  private db: any;
  private tools: ToolDef[] = [];
  /** Flat, row-major, L2-normalized vectors (length === tools.length * dim), or
   *  null when lexical-only. */
  private vectors: Float32Array | null = null;
  private dim = 0;
  /** In-memory per-id vector cache (issue #22). Lets a refresh reuse vectors for
   *  tools whose indexed text is unchanged and embed ONLY new/changed tools —
   *  independent of the disk sidecar, so it works even with `cache: false`. Each
   *  `vec` is a subarray view over the current `vectors` buffer. Rebuilt from
   *  scratch every successful build so removed ids never leak. */
  private vecById = new Map<string, { textHash: string; vec: Float32Array }>();
  /** id -> tool lookup for hit hydration. Rebuilt every `build()` (tools change
   *  on build/refresh), so it never goes stale; hoisted out of `search()` to
   *  avoid rebuilding it per query. */
  private byId = new Map<string, ToolDef>();
  constructor(private embedder?: Embedder) {}

  get hybrid(): boolean { return this.vectors !== null; }

  /** Embed via the flat fast path, falling back to a custom embedder's number[][]. */
  private async embedFlat(texts: string[]): Promise<{ data: Float32Array; dim: number }> {
    const e = this.embedder!;
    if (e.embedFlat) return e.embedFlat(texts);
    const arr = await e.embed(texts);
    const dim = arr[0]?.length ?? 0;
    const data = new Float32Array(texts.length * dim);
    for (let i = 0; i < arr.length; i++) data.set(arr[i]!, i * dim);
    return { data, dim };
  }

  /**
   * Build the index. Vectors for tools whose indexed text is unchanged are
   * reused from two caches before embedding: an in-memory per-id cache (issue
   * #22, survives across refreshes even with `cache: false`) and, when a
   * fingerprinted embedder + `cache` are present, the on-disk sidecar (issue
   * #21). Only new/changed tools are embedded; a full hit calls the embedder
   * zero times. `vecById` is rebuilt from scratch each successful build so ids
   * for removed tools are pruned.
   */
  async build(tools: ToolDef[], cache?: EmbeddingCache | null): Promise<void> {
    this.tools = tools;
    this.byId = new Map(tools.map((t) => [t.id, t]));
    this.db = create({ schema: { id: "string", text: "string" } });
    const texts = tools.map(indexText);
    await insertMultiple(this.db, tools.map((t, i) => ({ id: t.id, text: texts[i]! })));
    this.vectors = null;
    this.dim = 0;
    if (!this.embedder) { this.vecById.clear(); return; }
    if (tools.length === 0) { this.vecById.clear(); this.vectors = new Float32Array(0); return; } // trivially hybrid

    const fp = this.embedder.fingerprint;
    const store = fp && cache ? cache : null;
    const hashes = texts.map(embedTextHash);
    const cached = store ? store.read(fp!) : null;

    // Establish the working dim from any reuse source. All reused vectors must
    // share it; a reused vec of a different length is a stale-dim entry and is
    // NOT spliced in (treated as a miss instead).
    let dim = cached ? cached.dim : 0;
    const rows: Array<Float32Array | null> = new Array(tools.length).fill(null);
    const missIdx: number[] = [];
    for (let i = 0; i < tools.length; i++) {
      const id = tools[i]!.id;
      // a. in-memory hit (independent of the disk sidecar)
      const mem = this.vecById.get(id);
      if (mem && mem.textHash === hashes[i] && (dim === 0 || mem.vec.length === dim)) {
        rows[i] = mem.vec;
        if (dim === 0) dim = mem.vec.length;
        continue;
      }
      // b. disk hit
      if (cached) {
        const e = cached.byId.get(id);
        if (e && e.textHash === hashes[i]) { rows[i] = e.vec; continue; }
      }
      // c. miss -> embed
      missIdx.push(i);
    }
    this.dim = dim;

    if (missIdx.length) {
      let flat: { data: Float32Array; dim: number };
      try {
        flat = await this.embedFlat(missIdx.map((i) => texts[i]!));
      } catch {
        this.vectors = null;   // embedder unavailable -> graceful lexical-only
        this.vecById.clear();  // don't leave a half-updated cache to serve stale vecs
        return;
      }
      // dim can only differ from a reused dim under a model/format change the
      // fingerprint didn't catch; if it does, discard ALL reused rows (they're
      // the wrong length) and re-embed everything at the new dim.
      if (this.dim && flat.dim !== this.dim) {
        try { flat = await this.embedFlat(texts); } catch { this.vectors = null; this.vecById.clear(); return; }
        this.dim = flat.dim;
        for (let i = 0; i < tools.length; i++) rows[i] = flat.data.subarray(i * flat.dim, (i + 1) * flat.dim);
      } else {
        this.dim = flat.dim;
        for (let j = 0; j < missIdx.length; j++) rows[missIdx[j]!] = flat.data.subarray(j * flat.dim, (j + 1) * flat.dim);
      }
    }

    if (!this.dim) { this.vectors = null; this.vecById.clear(); return; }
    const flatVecs = new Float32Array(tools.length * this.dim);
    for (let i = 0; i < tools.length; i++) flatVecs.set(rows[i]!, i * this.dim);
    this.vectors = flatVecs;

    // Rebuild vecById over exactly the current tool set (prunes removed ids).
    // Each entry views the live `flatVecs` buffer, so no vectors are copied.
    this.vecById.clear();
    for (let i = 0; i < tools.length; i++) {
      this.vecById.set(tools[i]!.id, { textHash: hashes[i]!, vec: flatVecs.subarray(i * this.dim, (i + 1) * this.dim) });
    }

    // Persist only when we actually embedded something new (avoid churn on full hits).
    if (store && missIdx.length) {
      store.write(fp!, this.dim, tools.map((t, i) => ({
        id: t.id,
        textHash: hashes[i]!,
        vec: flatVecs.subarray(i * this.dim, (i + 1) * this.dim),
      })));
    }
  }

  async search(query: string, topK = 8): Promise<SearchHit[]> {
    const res = await oramaSearch(this.db, { term: query, limit: this.tools.length, threshold: 1 });
    const lexRank: string[] = res.hits.map((h: any) => h.document.id);

    const lexicalOrder = (): Array<{ id: string; score: number }> => {
      const max = res.hits[0]?.score ?? 1;
      return res.hits.map((h: any) => ({ id: h.document.id, score: max ? h.score / max : 0 }));
    };

    let order: Array<{ id: string; score: number }>;
    if (this.vectors && this.dim && this.embedder) {
      try {
        const { data: qv, dim } = await this.embedFlat([query]);
        if (dim !== this.dim) throw new Error("query/index dim mismatch");
        const semRank = this.tools
          .map((t, i) => ({ id: t.id, s: dot(qv, this.vectors!, i, this.dim) }))
          .sort((a, b) => b.s - a.s)
          .map((r) => r.id);
        order = rrf(lexRank, semRank);
      } catch {
        order = lexicalOrder(); // embedder died at query time -> lexical for this call
      }
    } else {
      order = lexicalOrder();
    }

    return order.slice(0, topK).map(({ id, score }) => {
      const t = this.byId.get(id)!;
      return { id: t.id, name: t.name, summary: summary(t), server: t.server, score: +score.toFixed(3) };
    });
  }
}

/** Reciprocal Rank Fusion, normalized to a 0-1 score. */
function rrf(a: string[], b: string[], k = 60): Array<{ id: string; score: number }> {
  const acc = new Map<string, number>();
  const add = (l: string[]) => l.forEach((id, i) => acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1)));
  add(a); add(b);
  const ranked = [...acc.entries()].sort((x, y) => y[1] - x[1]);
  const max = ranked[0]?.[1] ?? 1;
  return ranked.map(([id, s]) => ({ id, score: s / max }));
}
