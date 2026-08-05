// Gateway transports. stdio = local desktop hosts (Claude Desktop/Cursor/Claude
// Code plugin). Streamable-HTTP + bearer = remote/hosted.
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Winnow } from "../client.js";
import type { CallContext } from "../types.js";
import { createGateway } from "./server.js";

export { createGateway } from "./server.js";

/** Per-request upstream identity (multi-tenant passthrough): map an incoming HTTP
 *  request to per-server auth. Return undefined to use the upstreams' configured
 *  identity. This is the extension point — the deployer decides how an agent's
 *  request maps to upstream credentials (e.g. look up a JWT sub, read a header). */
export type AuthResolver = (req: http.IncomingMessage) => Record<string, CallContext> | undefined;

/** Batteries-included resolver: forward a per-server request header as that
 *  upstream's bearer. `map` is serverName -> header name. A leading "Bearer " on
 *  the header value is stripped. Absent headers -> that server uses its config auth. */
export function forwardHeaderAuth(map: Record<string, string>): AuthResolver {
  const pairs = Object.entries(map).map(([server, header]) => [server, header.toLowerCase()] as const);
  return (req) => {
    const out: Record<string, CallContext> = {};
    for (const [server, header] of pairs) {
      const v = req.headers[header];
      const raw = Array.isArray(v) ? v[0] : v;
      if (raw) out[server] = { bearer: raw.replace(/^Bearer\s+/i, "") };
    }
    return Object.keys(out).length ? out : undefined;
  };
}

/** Serve the gateway over stdio (one connection on this process's stdin/stdout).
 *  Note: keep stdout clean — MCP stdio is JSON-RPC only; log to stderr. */
export async function serveStdio(winnow: Winnow, opts?: { name?: string; version?: string }): Promise<void> {
  const server = createGateway(winnow, opts);
  await server.connect(new StdioServerTransport());
}

export interface HttpGatewayOptions {
  port: number;
  /** Require this bearer token on every request (browserless auth). */
  token?: string;
  name?: string;
  version?: string;
  /** Per-request upstream identity (multi-tenant passthrough). Absent -> all
   *  requests use the upstreams' configured identity (the default). */
  resolveAuth?: AuthResolver;
}

/** Serve the gateway over Streamable-HTTP (stateless: fresh transport per request,
 *  sharing the one Winnow instance). Returns the listening http.Server. */
export async function serveHttp(winnow: Winnow, opts: HttpGatewayOptions): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const auth = opts.resolveAuth?.(req);
    const mcp = createGateway(winnow, { name: opts.name, version: opts.version, auth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(opts.port, r));
  return server;
}
