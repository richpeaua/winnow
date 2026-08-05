import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Winnow, createGateway } from "../src/index.ts";
import { githubServer, slackServer } from "../examples/servers.ts";

/** Wire a raw MCP client to the gateway over an in-memory transport (no spawning). */
async function connectHost() {
  const winnow = new Winnow({ upstreams: [githubServer(), slackServer()] });
  await winnow.init();
  const gateway = createGateway(winnow);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverT);
  const host = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: {} });
  await host.connect(clientT);
  return { host, winnow };
}

test("gateway: exposes exactly the 4 meta-tools", async () => {
  const { host, winnow } = await connectHost();
  const { tools } = await host.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["call_tool", "load_tool", "run_code", "search_tools"]);
  await host.close();
  await winnow.close();
});

test("gateway: search_tools -> call_tool reaches an upstream through the server", async () => {
  const { host, winnow } = await connectHost();
  const s: any = await host.callTool({ name: "search_tools", arguments: { query: "post a message to slack" } });
  const hits = s.structuredContent.hits;
  assert.ok(hits.some((h: any) => h.id === "slack:create_message"));

  const c: any = await host.callTool({ name: "call_tool", arguments: { id: "slack:create_message", args: { channel: "C1", text: "hi" }, project: "{ok: ok}" } });
  assert.deepEqual(c.structuredContent.output, { ok: true });
  await host.close();
  await winnow.close();
});

test("gateway: run_code composes server-side and returns a small result", async () => {
  const { host, winnow } = await connectHost();
  const r: any = await host.callTool({ name: "run_code", arguments: { code: `
    const prs = await mcp.github.listPullRequests({ state: "open" });
    return prs.filter(p => (p.requested_reviewers || []).length === 0).length;
  ` } });
  assert.ok(typeof r.structuredContent.output === "number" && r.structuredContent.output > 0);
  await host.close();
  await winnow.close();
});
