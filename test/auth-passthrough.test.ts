import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Winnow, MockUpstream, createGateway, forwardHeaderAuth } from "../src/index.ts";

// A mock upstream whose tool echoes the per-call identity it was invoked with —
// so a test can prove which bearer reached the upstream.
function whoamiServer() {
  return new MockUpstream("svc", [
    {
      name: "whoami",
      description: "Return the caller's identity as seen by the upstream.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, ctx) => ({ seenBearer: ctx?.bearer ?? null }),
    },
  ]);
}

test("auth: per-server auth override reaches the upstream on call()", async () => {
  const client = new Winnow({ upstreams: [whoamiServer()], cache: false });
  await client.init();

  const withAuth = await client.call("svc:whoami", {}, { auth: { svc: { bearer: "tok-A" } } });
  assert.deepEqual(withAuth.output, { seenBearer: "tok-A" });

  const noAuth = await client.call("svc:whoami", {});
  assert.deepEqual(noAuth.output, { seenBearer: null }, "no override -> upstream's configured identity");
  await client.close();
});

test("auth: exec() threads the identity to every in-sandbox call", async () => {
  const client = new Winnow({ upstreams: [whoamiServer()], cache: false });
  await client.init();
  const r = await client.exec(`const me = await mcp.svc.whoami({}); return me.seenBearer;`, {
    auth: { svc: { bearer: "tok-X" } },
  });
  assert.equal(r.output, "tok-X");
  await client.close();
});

test("auth: forwardHeaderAuth maps request headers to per-server bearers", () => {
  const resolve = forwardHeaderAuth({ svc: "x-svc-auth", other: "x-other-auth" });
  const req: any = { headers: { "x-svc-auth": "Bearer tok-h", "x-unrelated": "nope" } };
  assert.deepEqual(resolve(req), { svc: { bearer: "tok-h" } }, "strips 'Bearer ' and ignores absent/unrelated headers");
  assert.equal(resolve({ headers: {} } as any), undefined, "no matching headers -> undefined (use configured identity)");
});

test("auth: gateway applies the resolved identity to call_tool", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer()], cache: false });
  await winnow.init();
  // Simulate what serveHttp does per request: resolve identity, build a gateway with it.
  const auth = forwardHeaderAuth({ svc: "x-svc-auth" })({ headers: { "x-svc-auth": "tok-req" } } as any);
  const gateway = createGateway(winnow, { auth });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverT);
  const host = new Client({ name: "host", version: "1.0.0" }, { capabilities: {} });
  await host.connect(clientT);

  const c: any = await host.callTool({ name: "call_tool", arguments: { id: "svc:whoami", args: {} } });
  assert.deepEqual(c.structuredContent.output, { seenBearer: "tok-req" });
  await host.close();
  await winnow.close();
});
