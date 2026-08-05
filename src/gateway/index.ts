// Gateway transports. stdio = local desktop hosts (Claude Desktop/Cursor/Claude
// Code plugin). Streamable-HTTP + bearer = remote/hosted.
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Winnow } from "../client.js";
import { createGateway } from "./server.js";

export { createGateway } from "./server.js";

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
    const mcp = createGateway(winnow, { name: opts.name, version: opts.version });
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
