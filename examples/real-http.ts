// Live test of the Streamable-HTTP transport: stand up a real MCP server over
// HTTP (stateless) that REQUIRES a bearer token, then drive it through the SDK's
// HttpUpstream — proving both the transport and header-based auth injection.
// Run: npx tsx examples/real-http.ts
import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpClient } from "../src/index.ts";
import { HttpUpstream } from "../src/upstream/http.ts";

const TOKEN = "s3cret-" + "token";
const PORT = 39876;

function buildServer(): McpServer {
  const server = new McpServer({ name: "http-demo", version: "1.0.0" });
  server.tool("echo", "Echo a message back", { message: z.string() }, async ({ message }) => ({
    content: [{ type: "text", text: `Echo: ${message}` }],
  }));
  server.tool("list_numbers", "Return a list of numbers with metadata", { n: z.number() }, async ({ n }) => {
    const items = Array.from({ length: n }, (_, i) => ({ i, sq: i * i, label: `item-${i}` }));
    return { content: [{ type: "text" as const, text: JSON.stringify({ items }) }], structuredContent: { items } };
  });
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = http.createServer(async (req, res) => {
  // Enforce bearer auth BEFORE handing off — this is what our client must satisfy.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  // Stateless: fresh server + transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
});

await new Promise<void>((r) => httpServer.listen(PORT, r));
console.log(`local Streamable-HTTP MCP server listening on :${PORT} (bearer required)\n`);

// 1. Happy path: correct bearer.
const client = new McpClient({
  upstreams: [new HttpUpstream("demo", { url: `http://127.0.0.1:${PORT}/mcp`, bearer: TOKEN })],
});
const info = await client.init();
console.log(`connected over HTTP: ${info.tools} tools discovered`);

const hits = await client.searchTools("echo a message");
console.log("search 'echo a message' -> top:", hits[0]?.id, `(${hits[0]?.score.toFixed(2)})`);

const echo = await client.call("demo:echo", { message: "over http" });
console.log("call demo:echo ->", JSON.stringify(echo.output));

const nums = await client.call("demo:list_numbers", { n: 5 }, { project: "items[].sq" });
console.log("call demo:list_numbers (projected items[].sq) ->", JSON.stringify(nums.output), `(${nums.tokens} tok)`);
await client.close();

// 2. Negative path: a wrong bearer must be rejected by the server (401). Per the
// C1 catalog model, a per-server list failure is warn-and-skip, so we assert the
// server was skipped and no tools leaked in — proving the 401 actually landed.
const bad = new McpClient({ upstreams: [new HttpUpstream("demo", { url: `http://127.0.0.1:${PORT}/mcp`, bearer: "wrong" })] });
const badInfo = await bad.init();
await bad.close();
const rejected = badInfo.skipped.includes("demo") && badInfo.tools === 0;
console.log(`\nwrong-token: server skipped=${JSON.stringify(badInfo.skipped)}, tools=${badInfo.tools} -> ${rejected ? "401 enforced ✅" : "auth NOT enforced ❌"}`);

httpServer.close();
console.log(rejected ? "\nHTTP transport + bearer auth: OK" : "\nauth check failed");
process.exit(rejected ? 0 : 1);
