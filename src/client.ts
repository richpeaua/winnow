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
  // Single-flight refresh: at most one drain runs; concurrent requests coalesce
  // into a per-server dirty set (or a full-refresh flag) drained sequentially.
  private dirtyServers = new Set<string>();
  private refreshAll = false;
  private refreshRunning: Promise<void> | null = null;

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
        // Upstreams fire this callback fire-and-forget (`void onChanged()`), so a
        // rejected watch-driven refresh would surface as an unhandled rejection.
        // Return the .catch()-wrapped promise: the attached handler swallows+logs
        // the rejection (the single-flight worker still resets, so a later refresh
        // recovers), while a caller that DOES await the callback (e.g. the mock)
        // still observes completion. Manual refresh() callers see the rejection.
        const unsub = await u.watch(() =>
          this.refresh(u.server).catch((e) =>
            console.warn(`[mcp-winnow] watch refresh for "${u.server}" failed: ${String(e).split("\n")[0]}`)));
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
    if (server) this.dirtyServers.add(server); else this.refreshAll = true;
    return this.drainRefresh();
  }

  /** Single-flight worker: serializes catalog.refresh so no two SearchIndex.build
   *  runs interleave, and coalesces bursts. A request made mid-drain lands in the
   *  dirty set and is picked up by the while-loop's next iteration (no lost update).
   *  On a throw the drain rejects (joined callers all see it) but refreshRunning is
   *  reset in finally, so a later refresh starts a fresh drain — never wedged. A
   *  dirty-set entry left unprocessed by a mid-drain throw is intentionally dropped
   *  (best-effort; the next explicit refresh re-lists it). */
  private drainRefresh(): Promise<void> {
    if (this.refreshRunning) return this.refreshRunning; // join the in-flight drain
    this.refreshRunning = (async () => {
      try {
        while (this.refreshAll || this.dirtyServers.size) {
          if (this.refreshAll) {
            this.refreshAll = false;
            this.dirtyServers.clear();
            for (const u of this.opts.upstreams) await this.catalog.refresh(u, this.cacheOpts);
          } else {
            const servers = [...this.dirtyServers];
            this.dirtyServers.clear();
            for (const s of servers) {
              const u = this.byServer.get(s);
              if (u) await this.catalog.refresh(u, this.cacheOpts);
            }
          }
          for (const cb of this.listeners) cb(); // fire toolsChanged after each applied batch
        }
      } finally {
        this.refreshRunning = null;
      }
    })();
    return this.refreshRunning;
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
