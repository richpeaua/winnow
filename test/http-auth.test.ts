import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Winnow, HttpUpstream, clientCredentials, preProvisionedOAuth } from "../src/index.ts";

const CID = "cid", SECRET = "s3cret";
const CC_ACCESS = "cc-access-token";     // issued by /token for correct creds
const OAUTH_ACCESS = "oauth-access-token"; // a pre-provisioned token the server accepts
const VALID = new Set([CC_ACCESS, OAUTH_ACCESS]);

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function buildServer(): McpServer {
  const s = new McpServer({ name: "auth-demo", version: "1.0.0" });
  s.tool("echo", "Echo a message", { message: z.string() }, async ({ message }) => ({ content: [{ type: "text", text: `Echo: ${message}` }] }));
  return s;
}

/** Server: POST /token (client_credentials) + bearer-gated /mcp. Returns its base URL. */
async function startServer(): Promise<{ base: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const ok = form.get("grant_type") === "client_credentials" && form.get("client_id") === CID && form.get("client_secret") === SECRET;
      if (!ok) { res.writeHead(401).end(JSON.stringify({ error: "invalid_client" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: CC_ACCESS, token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    // MCP endpoint — require a valid bearer.
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !VALID.has(auth.slice(7))) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const mcp = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === "POST" ? JSON.parse(await readBody(req)) : undefined);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("auth: client_credentials grant fetches a token and authenticates", async () => {
  const { base, close } = await startServer();
  try {
    const getBearer = clientCredentials({ clientId: CID, clientSecret: SECRET, tokenUrl: `${base}/token` });
    const w = new Winnow({ upstreams: [new HttpUpstream("svc", { url: `${base}/mcp`, getBearer })], cache: false });
    const info = await w.init();
    assert.deepEqual(info.skipped, [], "authenticated — not skipped");
    assert.ok(info.tools >= 1);
    const r = await w.call("svc:echo", { message: "hi" });
    assert.equal(r.output, "Echo: hi");
    await w.close();
  } finally { close(); }
});

test("auth: pre-provisioned oauth token authenticates", async () => {
  const { base, close } = await startServer();
  try {
    const getBearer = preProvisionedOAuth(JSON.stringify({ access_token: OAUTH_ACCESS }));
    const w = new Winnow({ upstreams: [new HttpUpstream("svc", { url: `${base}/mcp`, getBearer })], cache: false });
    const info = await w.init();
    assert.deepEqual(info.skipped, []);
    assert.ok(info.tools >= 1);
    await w.close();
  } finally { close(); }
});

test("auth: wrong client_credentials secret -> token request fails -> server skipped", async () => {
  const { base, close } = await startServer();
  try {
    const getBearer = clientCredentials({ clientId: CID, clientSecret: "WRONG", tokenUrl: `${base}/token` });
    const w = new Winnow({ upstreams: [new HttpUpstream("svc", { url: `${base}/mcp`, getBearer })], cache: false });
    const info = await w.init();
    assert.deepEqual(info.skipped, ["svc"], "bad creds -> skipped, no tools leaked");
    assert.equal(info.tools, 0);
    await w.close();
  } finally { close(); }
});
