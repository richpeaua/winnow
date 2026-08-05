// Meta-tool adapter (A2): surface exactly FOUR tools to a model instead of
// hundreds — the def-bloat payoff at the model layer. The later thin gateway
// adapter (deferred fog) wraps this same surface over MCP.
import type { Winnow } from "./client.js";

export interface MetaToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const META_TOOLS: MetaToolDef[] = [
  {
    name: "search_tools",
    description: "Search tools across all connected MCP servers by natural-language intent. Returns ranked minimal entries {id,name,summary,server,score}. Load full schemas with load_tool before calling. If the top score is low, use list_tools to browse.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, topK: { type: "integer" } }, required: ["query"] },
  },
  {
    name: "load_tool",
    description: "Load full input schema(s) for one or more tool ids from search_tools.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "call_tool",
    description: "Call one tool by id. Optional JMESPath `project` and `maxTokens` trim the result before it returns.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, args: { type: "object" }, project: { type: "string" }, maxTokens: { type: "integer" } }, required: ["id", "args"] },
  },
  {
    name: "run_code",
    description: "Run sandboxed TypeScript against typed per-server modules to compose many calls and return only a small computed result.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
];

/** Dispatch a meta-tool call to the client. This is the whole model-facing surface. */
export async function dispatchMetaTool(client: Winnow, name: string, args: any): Promise<unknown> {
  switch (name) {
    case "search_tools": return client.searchTools(args.query, { topK: args.topK });
    case "load_tool": return client.loadTool(args.ids);
    case "call_tool": return client.call(args.id, args.args, { project: args.project, maxTokens: args.maxTokens });
    case "run_code": return client.exec(args.code);
    default: throw new Error(`unknown meta-tool: ${name}`);
  }
}
