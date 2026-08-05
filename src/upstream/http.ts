// Real Streamable-HTTP upstream (spec 2026-07-28 current transport). Lazy connect.
// Headless auth (all browserless): static bearer, pre-provisioned OAuth, or the
// client_credentials grant — resolved via a BearerProvider (see auth.ts); the
// connection re-establishes when a refreshed token changes the bearer.
import type { CallContext, ToolDef, ToolResult } from "../types.js";
import type { UpstreamConnection } from "./types.js";
import type { BearerProvider } from "../auth.js";

/** Max distinct per-identity connections cached for multi-tenant passthrough.
 *  Beyond this the least-recently-used identity connection is closed (see #7). */
const MAX_IDENTITY_CLIENTS = 32;

export interface HttpUpstreamConfig {
  url: string;
  headers?: Record<string, string>;
  /** Static pre-provisioned bearer token (already interpolated from env). */
  bearer?: string;
  /** Dynamic bearer source (oauth / client_credentials); takes precedence over `bearer`. */
  getBearer?: BearerProvider;
}

export class HttpUpstream implements UpstreamConnection {
  private client: any = null;
  private connecting: Promise<any> | null = null;
  private currentBearer: string | undefined;
  // Per-identity connections for auth passthrough, keyed by bearer+headers.
  // Insertion order = LRU order (re-inserted on hit).
  private idClients = new Map<string, any>();

  constructor(public readonly server: string, private cfg: HttpUpstreamConfig) {}

  get identity(): string {
    return `http:${this.cfg.url}`;
  }

  private async connect(): Promise<any> {
    // Resolve the bearer every time (client_credentials refreshes on expiry).
    const bearer = this.cfg.getBearer ? await this.cfg.getBearer() : this.cfg.bearer;
    if (this.client && bearer === this.currentBearer) return this.client;
    if (this.client) { try { await this.client.close(); } catch { /* reconnect on token change */ } this.client = null; }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const headers = {
        ...(this.cfg.headers ?? {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      };
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), { requestInit: { headers } });
      const client = new Client({ name: "mcp-winnow", version: "0.0.1" }, { capabilities: {} });
      await client.connect(transport);
      this.client = client;
      this.currentBearer = bearer;
      return client;
    })();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async listTools(): Promise<ToolDef[]> {
    const client = await this.connect();
    const out: ToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools ?? []) {
        out.push({ id: `${this.server}:${t.name}`, server: this.server, name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, outputSchema: t.outputSchema });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /** Open (or reuse) a connection acting as a specific identity — the per-call
   *  auth override. Kept separate from the default `connect()` path (which stays
   *  refresh-aware for the configured credential). Bounded LRU cache. */
  private async connectAs(ctx: CallContext): Promise<any> {
    const key = JSON.stringify([ctx.bearer ?? null, ctx.headers ?? null]);
    const hit = this.idClients.get(key);
    if (hit) { this.idClients.delete(key); this.idClients.set(key, hit); return hit; } // LRU bump
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const headers = {
      ...(this.cfg.headers ?? {}),
      ...(ctx.headers ?? {}),
      ...(ctx.bearer ? { Authorization: `Bearer ${ctx.bearer}` } : {}),
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), { requestInit: { headers } });
    const client = new Client({ name: "mcp-winnow", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    this.idClients.set(key, client);
    if (this.idClients.size > MAX_IDENTITY_CLIENTS) {
      const lruKey = this.idClients.keys().next().value as string;
      const lru = this.idClients.get(lruKey);
      this.idClients.delete(lruKey);
      try { await lru.close(); } catch { /* already gone */ }
    }
    return client;
  }

  async callTool(name: string, args: unknown, ctx?: CallContext): Promise<ToolResult> {
    // A per-call identity (bearer/headers) uses its own connection; otherwise the
    // default configured connection.
    const client = ctx && (ctx.bearer || ctx.headers) ? await this.connectAs(ctx) : await this.connect();
    const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
    return { content: res.content, structuredContent: res.structuredContent, isError: res.isError };
  }

  async watch(onChanged: () => void | Promise<void>): Promise<() => void> {
    const client = await this.connect();
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void onChanged(); });
    return () => { try { client.removeNotificationHandler("notifications/tools/list_changed"); } catch { /* already gone */ } };
  }

  async close(): Promise<void> {
    if (this.client) { await this.client.close(); this.client = null; }
    for (const c of this.idClients.values()) { try { await c.close(); } catch { /* already gone */ } }
    this.idClients.clear();
  }
}
