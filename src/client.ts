// The public McpClient facade (A2): searchTools -> loadTool -> call, plus exec
// (stub) and lifecycle. Every anti-bloat mechanism is exposed exactly once.
import { Catalog } from "./catalog.ts";
import { filterResult, approxTokens } from "./filter.ts";
import { runSandbox, type ExecOpts } from "./sandbox.ts";
import type { CallOpts, CatalogEntry, Embedder, FilteredResult, ResultFilterPolicy, SearchHit, ToolDef, TokenCounter } from "./types.ts";
import type { UpstreamConnection } from "./upstream/types.ts";

export interface McpClientOptions {
  /** Upstream servers. (Config-driven wiring is a separate stub; inject here.) */
  upstreams: UpstreamConnection[];
  /** Optional embedder -> hybrid search. Absent -> lexical-only (see recall caveat). */
  embedder?: Embedder;
  /** Optional exact tokenizer for the F1 cap; defaults to a ~4char/token approximation. */
  tokenCounter?: TokenCounter;
  /** Global default result-token cap (F1). */
  defaultMaxTokens?: number;
  /** Default search top-k. */
  topK?: number;
  /** Static per-tool result-filter policies, keyed by tool id. */
  policies?: Record<string, ResultFilterPolicy>;
}

export class McpClient {
  private catalog: Catalog;
  private byServer = new Map<string, UpstreamConnection>();
  private ready = false;
  private listeners = new Set<() => void>();

  constructor(private opts: McpClientOptions) {
    this.catalog = new Catalog(opts.embedder);
    for (const u of opts.upstreams) this.byServer.set(u.server, u);
  }

  /** Build the catalog + search index (or load cache, in the full impl). */
  async init(): Promise<{ tools: number; hybrid: boolean; skipped: string[] }> {
    const { skipped } = await this.catalog.build(this.opts.upstreams);
    this.ready = true;
    return { tools: this.catalog.size, hybrid: this.catalog.hybrid, skipped };
  }

  private assertReady() { if (!this.ready) throw new Error("call init() before using the client"); }

  searchTools(query: string, opts: { topK?: number } = {}): Promise<SearchHit[]> {
    this.assertReady();
    return this.catalog.search(query, opts.topK ?? this.opts.topK ?? 8);
  }

  loadTool(ids: string | string[]): ToolDef[] {
    this.assertReady();
    return this.catalog.loadTool(ids);
  }

  /** Escape hatch for low-confidence search: browse a server's tools. */
  listTools(server?: string): CatalogEntry[] {
    this.assertReady();
    return this.catalog.listTools(server);
  }

  async call(id: string, args: unknown, opts: CallOpts = {}): Promise<FilteredResult> {
    this.assertReady();
    if (!this.catalog.has(id)) throw new Error(`unknown tool id: ${id}`);
    const [server, name] = splitId(id);
    const upstream = this.byServer.get(server);
    if (!upstream) throw new Error(`no connection for server: ${server}`);
    const raw = await upstream.callTool(name, args);
    const policy = this.opts.policies?.[id];
    return filterResult(
      raw,
      { ...opts, policy, maxTokens: opts.maxTokens ?? this.opts.defaultMaxTokens },
      this.opts.tokenCounter ?? approxTokens
    );
  }

  /** Sandboxed multi-tool composition (STUB — see sandbox.ts). */
  async exec(code: string, opts: ExecOpts = {}): Promise<FilteredResult> {
    this.assertReady();
    return runSandbox(code, { call: (id, a) => this.call(id, a) }, opts);
  }

  listServers(): Array<{ server: string }> {
    return [...this.byServer.keys()].map((server) => ({ server }));
  }

  on(event: "toolsChanged", cb: () => void): void {
    if (event === "toolsChanged") this.listeners.add(cb);
  }

  async close(): Promise<void> {
    await Promise.all(this.opts.upstreams.map((u) => u.close()));
    this.listeners.clear();
  }
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  if (i < 0) throw new Error(`malformed tool id (expected server:name): ${id}`);
  return [id.slice(0, i), id.slice(i + 1)];
}
