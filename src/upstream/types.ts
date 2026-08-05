import type { ToolDef, ToolResult } from "../types.js";

/**
 * A connection to one upstream MCP server. Implementations connect lazily
 * (per the catalog model: eager-list at init, then reconnect on call).
 */
export interface UpstreamConnection {
  readonly server: string;
  /** List this server's tools (paginated internally). Connects if needed. */
  listTools(): Promise<ToolDef[]>;
  /** Call a tool by its short name (without the `server:` prefix). */
  callTool(name: string, args: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}
