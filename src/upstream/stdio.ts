// Real stdio upstream, using @modelcontextprotocol/sdk. Lazy-connect per the
// catalog model: connects on first listTools/callTool, stays warm until close().
// The SDK is an optionalDependency, imported dynamically so the core stays light.
import type { ToolDef, ToolResult } from "../types.js";
import type { UpstreamConnection } from "./types.js";

export interface StdioUpstreamConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class StdioUpstream implements UpstreamConnection {
  private client: any = null;
  private connecting: Promise<any> | null = null;

  constructor(public readonly server: string, private cfg: StdioUpstreamConfig) {}

  private async connect(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(this.cfg.env ?? {}) },
      });
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
        out.push({
          id: `${this.server}:${t.name}`,
          server: this.server,
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
        });
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

  async close(): Promise<void> {
    if (this.client) { await this.client.close(); this.client = null; }
  }
}
