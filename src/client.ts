// The public Winnow facade (A2): searchTools -> loadTool -> call, plus exec
// (stub) and lifecycle. Every anti-bloat mechanism is exposed exactly once.
import { Catalog } from "./catalog.js";
import { filterResult, approxTokens, DEFAULT_MAX_TOKENS } from "./filter.js";
import { SandboxPool, type ExecOpts, type SandboxPoolOptions } from "./sandbox.js";
import { resolveConfig, buildUpstreams, policiesFromConfig } from "./config.js";
import type { CallContext, CallOpts, CatalogEntry, Embedder, FilteredResult, ResultFilterPolicy, SearchHit, ToolDef, TokenCounter } from "./types.js";
import type { UpstreamConnection } from "./upstream/types.js";

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
  /** Persist the catalog/index to disk (default true). false = ephemeral. */
  cache?: boolean;
  /** Cache directory (default ~/.cache/winnow). */
  cacheDir?: string;
  /** Cache TTL in ms (default 1h); an entry older than this is re-listed. */
  cacheTtlMs?: number;
  /** Opt-in: keep connections live and auto-refresh on tools/list_changed. */
  watch?: boolean;
  /** Bound run_code concurrency (workers/queue). Absent -> sensible defaults. */
  sandbox?: SandboxPoolOptions;
}

export class Winnow {
  private catalog: Catalog;
  private byServer = new Map<string, UpstreamConnection>();
  private ready = false;
  private listeners = new Set<() => void>();
  private unsubscribes: Array<() => void> = [];
  private pool?: SandboxPool;

  constructor(private opts: McpClientOptions) {
    this.catalog = new Catalog(opts.embedder);
    for (const u of opts.upstreams) this.byServer.set(u.server, u);
  }

  /** Build a client from a raw config object (file/env/programmatic). */
  static fromConfig(rawConfig: unknown, extra: Partial<Omit<McpClientOptions, "upstreams" | "policies">> = {}): Winnow {
    const config = resolveConfig(rawConfig);
    return new Winnow({
      upstreams: buildUpstreams(config),
      policies: policiesFromConfig(config),
      defaultMaxTokens: config.defaults.maxTokens,
      topK: config.search.topK,
      sandbox: config.sandbox,
      ...extra,
    });
  }

  private get cacheOpts() {
    return { cache: this.opts.cache, cacheDir: this.opts.cacheDir, ttlMs: this.opts.cacheTtlMs };
  }

  /** Build the catalog + search index. On a full (fresh) cache hit, makes zero
   *  upstream connections. `fromCache` lists the servers served from disk. */
  async init(): Promise<{ tools: number; hybrid: boolean; skipped: string[]; fromCache: string[]; watching: string[] }> {
    const { skipped, fromCache } = await this.catalog.build(this.opts.upstreams, this.cacheOpts);
    this.ready = true;
    const watching: string[] = [];
    if (this.opts.watch) {
      for (const u of this.opts.upstreams) {
        if (!u.watch) continue;
        const unsub = await u.watch(() => this.refresh(u.server));
        this.unsubscribes.push(unsub);
        watching.push(u.server);
      }
    }
    return { tools: this.catalog.size, hybrid: this.catalog.hybrid, skipped, fromCache, watching };
  }

  /** Re-list one server (or all), patch the catalog + index, refresh the cache,
   *  and fire 'toolsChanged'. Use to pick up a server whose tool set changed. */
  async refresh(server?: string): Promise<void> {
    this.assertReady();
    const targets = server ? [this.byServer.get(server)].filter(Boolean) as UpstreamConnection[] : this.opts.upstreams;
    for (const u of targets) await this.catalog.refresh(u, this.cacheOpts);
    for (const cb of this.listeners) cb();
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

  private get counter() { return this.opts.tokenCounter ?? approxTokens; }
  private get globalCap() { return this.opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS; }

  private async rawCall(id: string, args: unknown, auth?: Record<string, CallContext>): Promise<{ raw: unknown; policy?: ResultFilterPolicy }> {
    if (!this.catalog.has(id)) throw new Error(`unknown tool id: ${id}`);
    const [server, name] = splitId(id);
    const upstream = this.byServer.get(server);
    if (!upstream) throw new Error(`no connection for server: ${server}`);
    return { raw: await upstream.callTool(name, args, auth?.[server]), policy: this.opts.policies?.[id] };
  }

  /** Context-facing call: projection + static policy + the hard global cap (F1).
   *  `opts.auth` (per-server) overrides the upstream identity for this call. */
  async call(id: string, args: unknown, opts: CallOpts = {}): Promise<FilteredResult> {
    this.assertReady();
    const { raw, policy } = await this.rawCall(id, args, opts.auth);
    return filterResult(raw, { project: opts.project, maxTokens: opts.maxTokens, policy }, this.counter, this.globalCap);
  }

  /** In-sandbox call: projection/static-policy still apply, but NO blanket cap —
   *  intermediates never reach context; only exec()'s final return is capped. */
  private async execCall(id: string, args: unknown, auth?: Record<string, CallContext>): Promise<FilteredResult> {
    const { raw, policy } = await this.rawCall(id, args, auth);
    return filterResult(raw, { policy }, this.counter, Infinity);
  }

  /** Sandboxed multi-tool composition: run code against a `mcp.<server>.<tool>()` API.
   *  `opts.auth` (per-server) applies to every in-sandbox call. */
  async exec(code: string, opts: ExecOpts & { auth?: Record<string, CallContext> } = {}): Promise<FilteredResult> {
    this.assertReady();
    const tools = this.catalog.listTools().map((t) => ({ id: t.id, server: t.server, name: t.name }));
    if (!this.pool) this.pool = new SandboxPool((id, a, ctx) => this.execCall(id, a, (ctx as { auth?: Record<string, CallContext> } | undefined)?.auth), this.opts.sandbox, this.counter);
    return this.pool.run(code, tools, opts, { auth: opts.auth });
  }

  listServers(): Array<{ server: string }> {
    return [...this.byServer.keys()].map((server) => ({ server }));
  }

  on(event: "toolsChanged", cb: () => void): void {
    if (event === "toolsChanged") this.listeners.add(cb);
  }

  async close(): Promise<void> {
    for (const unsub of this.unsubscribes) { try { unsub(); } catch { /* ignore */ } }
    this.unsubscribes = [];
    await this.pool?.close();
    this.pool = undefined;
    await this.opts.embedder?.close?.();
    await Promise.all(this.opts.upstreams.map((u) => u.close()));
    this.listeners.clear();
  }
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  if (i < 0) throw new Error(`malformed tool id (expected server:name): ${id}`);
  return [id.slice(0, i), id.slice(i + 1)];
}
