// S1 tool-search: Orama BM25 (always on, the headless floor) + optional
// embedder (semantic) fused with RRF. Degrades to lexical-only when no
// embedder is available. Validated in bench/recall.js (hybrid 100% recall@8,
// lexical 88%) -> callers should pre-provision an embedder for headless.
import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import type { Embedder, SearchHit, ToolDef } from "./types.ts";

function indexText(t: ToolDef): string {
  const props = (t.inputSchema as any)?.properties ?? {};
  const params = Object.entries(props).map(([k, v]: [string, any]) => `${k} ${v?.description ?? ""}`).join(" ");
  const aliases = (t.aliases ?? []).join(" ");
  return `${t.server} ${t.name.replace(/_/g, " ")} ${t.description} ${aliases} ${params}`;
}

function summary(t: ToolDef): string {
  return (t.description.split(". ")[0] ?? t.description).slice(0, 100);
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

export class SearchIndex {
  private db: any;
  private tools: ToolDef[] = [];
  private vectors: number[][] | null = null;
  constructor(private embedder?: Embedder) {}

  get hybrid(): boolean { return this.vectors !== null; }

  async build(tools: ToolDef[]): Promise<void> {
    this.tools = tools;
    this.db = create({ schema: { id: "string", text: "string" } });
    await insertMultiple(this.db, tools.map((t) => ({ id: t.id, text: indexText(t) })));
    if (this.embedder) {
      try {
        this.vectors = await this.embedder.embed(tools.map(indexText));
      } catch {
        this.vectors = null; // graceful degradation to lexical-only
      }
    }
  }

  async search(query: string, topK = 8): Promise<SearchHit[]> {
    const res = await oramaSearch(this.db, { term: query, limit: this.tools.length, threshold: 1 });
    const lexRank: string[] = res.hits.map((h: any) => h.document.id);

    let order: Array<{ id: string; score: number }>;
    if (this.vectors && this.embedder) {
      const [qv] = await this.embedder.embed([query]);
      const semRank = this.tools
        .map((t, i) => ({ id: t.id, s: cosine(qv!, this.vectors![i]!) }))
        .sort((a, b) => b.s - a.s)
        .map((r) => r.id);
      order = rrf(lexRank, semRank);
    } else {
      const max = res.hits[0]?.score ?? 1;
      order = res.hits.map((h: any) => ({ id: h.document.id, score: max ? h.score / max : 0 }));
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
