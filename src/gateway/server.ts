// P4 gateway: expose a Winnow instance as an MCP server with exactly the four
// meta-tools. Any MCP host connects to ONE server and sees FOUR tools while
// Winnow hides N upstream servers behind search/load/call/run_code.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Winnow } from "../client.js";
import type { CallContext } from "../types.js";

const asContent = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }],
});

/** Per-request multi-tenant auth carrier. A pooled gateway server is shared across
 *  requests and MUST NOT bake in any tenant identity; instead each HTTP request runs
 *  its handler inside `authStore.run({ auth }, …)`, and the call_tool/run_code
 *  handlers read the CURRENT request's auth from this AsyncLocalStorage. Two
 *  concurrent requests get two independent ALS frames, so a bearer can never bleed
 *  across tenants. If the ALS context is lost, getStore() is undefined and we
 *  fail-closed to `opts.auth` (a directly-constructed gateway's fixed auth) or the
 *  upstream's configured identity — never another tenant's bearer. */
export const authStore = new AsyncLocalStorage<{ auth?: Record<string, CallContext> }>();

/** `auth` is the per-request upstream identity (multi-tenant passthrough), applied
 *  to every call_tool / run_code invocation on this (per-request) gateway instance. */
export function createGateway(winnow: Winnow, opts: { name?: string; version?: string; auth?: Record<string, CallContext> } = {}): McpServer {
  const server = new McpServer({ name: opts.name ?? "winnow", version: opts.version ?? "0.1.0" });

  server.tool(
    "search_tools",
    "Search tools across all connected MCP servers by natural-language intent. Returns ranked minimal entries {id,name,summary,server,score}. Load full schemas with load_tool before calling; if the top score is low, browse with the server's tools instead of guessing.",
    { query: z.string(), topK: z.number().int().positive().optional() },
    async ({ query, topK }) => {
      const hits = await winnow.searchTools(query, { topK });
      return { ...asContent(hits), structuredContent: { hits } };
    }
  );

  server.tool(
    "load_tool",
    "Load full input schema(s) for one or more tool ids returned by search_tools.",
    { ids: z.array(z.string()).min(1) },
    async ({ ids }) => {
      const defs = winnow.loadTool(ids);
      return { ...asContent(defs), structuredContent: { defs } };
    }
  );

  server.tool(
    "call_tool",
    "Call one tool by id. Optional JMESPath `project` and `maxTokens` trim the result before it returns.",
    { id: z.string(), args: z.record(z.string(), z.unknown()).optional(), project: z.string().optional(), maxTokens: z.number().int().positive().optional() },
    async ({ id, args, project, maxTokens }) => {
      const auth = authStore.getStore()?.auth ?? opts.auth;
      const r = await winnow.call(id, args ?? {}, { project, maxTokens, auth });
      return { ...asContent(r.output), structuredContent: { output: r.output, truncated: r.truncated }, isError: r.isError };
    }
  );

  server.tool(
    "run_code",
    "Run sandboxed TypeScript against a typed `mcp.<server>.<tool>()` facade to compose many tool calls and return only a small computed result. Runs server-side in Winnow's sandbox.",
    { code: z.string() },
    async ({ code }) => {
      const auth = authStore.getStore()?.auth ?? opts.auth;
      const r = await winnow.exec(code, { auth });
      return { ...asContent(r.output), structuredContent: { output: r.output }, isError: r.isError };
    }
  );

  return server;
}
