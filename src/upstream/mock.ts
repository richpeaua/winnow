// In-memory upstream server for tests/demo — lets the SDK run end-to-end with
// zero network. Real transports (stdio/http) implement the same interface.
import type { CallContext, ToolDef, ToolResult } from "../types.js";
import type { UpstreamConnection } from "./types.js";

export interface MockTool {
  name: string;
  description: string;
  inputSchema: unknown;
  aliases?: string[];
  handler: (args: any, ctx?: CallContext) => ToolResult | unknown | Promise<ToolResult | unknown>;
}

export class MockUpstream implements UpstreamConnection {
  // listDelayMs: optional artificial per-call delay for listTools, used by the
  // parallel-listing timing test to simulate real connect/list latency.
  constructor(public readonly server: string, private tools: MockTool[], private listDelayMs = 0) {}

  get identity(): string { return `mock:${this.server}`; }

  private watchers = new Set<() => void | Promise<void>>();

  /** Test helper: swap this server's tools (simulates a server whose set changed). */
  setTools(tools: MockTool[]): void { this.tools = tools; }

  /** Test helper: fire the change signal (awaits watcher callbacks). */
  async emitToolsChanged(): Promise<void> {
    for (const cb of this.watchers) await cb();
  }

  async watch(onChanged: () => void | Promise<void>): Promise<() => void> {
    this.watchers.add(onChanged);
    return () => { this.watchers.delete(onChanged); };
  }

  async listTools(): Promise<ToolDef[]> {
    if (this.listDelayMs > 0) await new Promise((r) => setTimeout(r, this.listDelayMs));
    return this.tools.map((t) => ({
      id: `${this.server}:${t.name}`,
      server: this.server,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      aliases: t.aliases,
    }));
  }

  async callTool(name: string, args: unknown, ctx?: CallContext): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `no such tool: ${name}` }] };
    const out = await tool.handler(args as any, ctx);
    // Normalize: object -> structuredContent, string -> text block.
    if (out && typeof out === "object" && !Array.isArray(out)) return { structuredContent: out };
    if (Array.isArray(out)) return { structuredContent: out };
    return { content: [{ type: "text", text: String(out) }] };
  }

  async close(): Promise<void> {}
}
