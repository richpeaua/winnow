// Real Streamable-HTTP upstream (spec 2026-07-28 current transport). Lazy connect.
// Headless auth: a pre-provisioned bearer token via header (browserless).
// Seeded-OAuth / client_credentials grants are noted for follow-up.
import type { ToolDef, ToolResult } from "../types.js";
import type { UpstreamConnection } from "./types.js";

export interface HttpUpstreamConfig {
  url: string;
  headers?: Record<string, string>;
  /** Pre-provisioned bearer token (already interpolated from env). */
  bearer?: string;
}

export class HttpUpstream implements UpstreamConnection {
  private client: any = null;
  private connecting: Promise<any> | null = null;

  constructor(public readonly server: string, private cfg: HttpUpstreamConfig) {}

  get identity(): string {
    return `http:${this.cfg.url}`;
  }

  private async connect(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const headers = {
        ...(this.cfg.headers ?? {}),
        ...(this.cfg.bearer ? { Authorization: `Bearer ${this.cfg.bearer}` } : {}),
      };
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), { requestInit: { headers } });
      const client = new Client({ name: "mcp-winnow", version: "0.0.1" }, { capabilities: {} });
      await client.connect(transport);
      this.client = client;
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

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const client = await this.connect();
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
  }
}
