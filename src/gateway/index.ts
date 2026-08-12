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

/** Build a single idempotent shutdown path: run `before` (transport-specific
 *  teardown, e.g. stop the HTTP listener), close the Winnow instance (upstream
 *  children, sandbox pool, watches), then exit. A hard watchdog exits anyway if
 *  close() stalls (e.g. an HTTP upstream or a caller-supplied embedder that hangs)
 *  — the point is to never wedge the process on disconnect, so exit is not gated
 *  solely on a clean shutdown. Also wires SIGTERM/SIGINT so a host that signals
 *  instead of closing the transport still tears upstreams down (no orphans).
 *  Returns the shutdown fn so the caller can additionally trigger it (stdin EOF). */
function installGracefulShutdown(winnow: Winnow, before?: () => void): () => void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const kill = setTimeout(() => process.exit(0), 3000);
    kill.unref(); // never keep the loop alive on its own
    try { before?.(); } catch { /* best-effort teardown */ }
    void winnow.close().finally(() => process.exit(0));
  };
  // process.on (not once): the shuttingDown guard already makes shutdown a no-op
  // after the first call, so a second signal (impatient operator) is safely
  // ignored while cleanup finishes. With `once`, a second SIGTERM would hit
  // Node's default disposition and kill the process mid-close(), re-orphaning the
  // very upstreams this handler exists to reap. The watchdog bounds exit anyway.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return shutdown;
}

/** Serve the gateway over stdio (one connection on this process's stdin/stdout).
 *  Note: keep stdout clean — MCP stdio is JSON-RPC only; log to stderr. */
export async function serveStdio(winnow: Winnow, opts?: { name?: string; version?: string }): Promise<void> {
  const server = createGateway(winnow, opts);
  const transport = new StdioServerTransport();
  // stdin EOF (the client closed its end) must terminate this process. A warm
  // upstream child keeps Node's event loop alive, so without this the gateway
  // lingers after the client disconnects — hanging any client that waits for
  // the server to exit (e.g. a Go client's cmd.Wait()). Leaf servers with no
  // children exit naturally on EOF; shutting down upstreams restores that.
  // The SDK's StdioServerTransport only listens for stdin 'data'/'error', not
  // 'end', so we detect EOF ourselves rather than relying on transport.onclose.
  const shutdown = installGracefulShutdown(winnow);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
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
  // Signal-driven graceful shutdown: stop accepting connections, then close the
  // shared Winnow (upstream children, sandbox pool) before exiting, so a host
  // signalling the gateway doesn't orphan its upstreams. The watchdog still
  // guarantees exit if close() stalls.
  installGracefulShutdown(winnow, () => server.close());
  return server;
}
