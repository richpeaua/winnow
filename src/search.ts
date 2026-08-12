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
   * Build the index. With a `cache` and a fingerprinted embedder, per-tool
   * vectors are read from the on-disk sidecar; only tools whose indexed text
   * changed (or are absent) are re-embedded. A FULL hit calls the embedder
   * zero times — no worker/model load (issue #21).
   */
  async build(tools: ToolDef[], cache?: EmbeddingCache | null): Promise<void> {
    this.tools = tools;
    this.db = create({ schema: { id: "string", text: "string" } });
    await insertMultiple(this.db, tools.map((t) => ({ id: t.id, text: indexText(t) })));
    this.vectors = null;
    this.dim = 0;
    if (!this.embedder) return;
    if (tools.length === 0) { this.vectors = new Float32Array(0); return; } // trivially hybrid

    const fp = this.embedder.fingerprint;
    const store = fp && cache ? cache : null;
    const texts = tools.map(indexText);
    const hashes = texts.map(embedTextHash);
    const cached = store ? store.read(fp!) : null;

    const rows: Array<Float32Array | null> = new Array(tools.length).fill(null);
    const missIdx: number[] = [];
    if (cached) {
      this.dim = cached.dim;
      for (let i = 0; i < tools.length; i++) {
        const e = cached.byId.get(tools[i]!.id);
        if (e && e.textHash === hashes[i]) rows[i] = e.vec;
        else missIdx.push(i);
      }
    } else {
      for (let i = 0; i < tools.length; i++) missIdx.push(i);
    }

    if (missIdx.length) {
      let flat: { data: Float32Array; dim: number };
      try {
        flat = await this.embedFlat(missIdx.map((i) => texts[i]!));
      } catch {
        this.vectors = null; // embedder unavailable -> graceful lexical-only
        return;
      }
      // dim can only differ from a cached dim under file corruption (fingerprint
      // pins the model); if it does, discard cached rows and re-embed all.
      if (this.dim && flat.dim !== this.dim) {
        for (let i = 0; i < tools.length; i++) { if (rows[i]) { rows[i] = null; missIdx.push(i); } }
        try { flat = await this.embedFlat(texts); } catch { this.vectors = null; return; }
        this.dim = flat.dim;
        for (let i = 0; i < tools.length; i++) rows[i] = flat.data.subarray(i * flat.dim, (i + 1) * flat.dim);
      } else {
        this.dim = flat.dim;
        for (let j = 0; j < missIdx.length; j++) rows[missIdx[j]!] = flat.data.subarray(j * flat.dim, (j + 1) * flat.dim);
      }
    }

    if (!this.dim) { this.vectors = null; return; }
    const flatVecs = new Float32Array(tools.length * this.dim);
    for (let i = 0; i < tools.length; i++) flatVecs.set(rows[i]!, i * this.dim);
    this.vectors = flatVecs;

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

    const byId = new Map(this.tools.map((t) => [t.id, t]));
    return order.slice(0, topK).map(({ id, score }) => {
      const t = byId.get(id)!;
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
