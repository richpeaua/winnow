// In-memory upstream server for tests/demo — lets the SDK run end-to-end with
// zero network. Real transports (stdio/http) implement the same interface.
import type { ToolDef, ToolResult } from "../types.ts";
import type { UpstreamConnection } from "./types.ts";

export interface MockTool {
  name: string;
  description: string;
  inputSchema: unknown;
  aliases?: string[];
  handler: (args: any) => ToolResult | unknown;
}

export class MockUpstream implements UpstreamConnection {
  constructor(public readonly server: string, private tools: MockTool[]) {}

  async listTools(): Promise<ToolDef[]> {
    return this.tools.map((t) => ({
      id: `${this.server}:${t.name}`,
      server: this.server,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      aliases: t.aliases,
    }));
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `no such tool: ${name}` }] };
    const out = tool.handler(args as any);
    // Normalize: object -> structuredContent, string -> text block.
    if (out && typeof out === "object" && !Array.isArray(out)) return { structuredContent: out };
    if (Array.isArray(out)) return { structuredContent: out };
    return { content: [{ type: "text", text: String(out) }] };
  }

  async close(): Promise<void> {}
}
