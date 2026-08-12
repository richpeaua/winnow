// Pool + AsyncLocalStorage gateway (issue #26): the stateless HTTP gateway reuses a
// small pool of auth-less McpServers across requests (O(1) construction, not per
// request) while carrying per-request tenant auth through AsyncLocalStorage so
// concurrent tenants can never bleed. These tests drive real HTTP against serveHttp.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Winnow, MockUpstream, serveHttp, forwardHeaderAuth } from "../src/index.ts";
import { createGateway } from "../src/gateway/server.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// whoami upstream that echoes the per-call bearer, with an optional delay so
// concurrent in-flight calls genuinely overlap (a shared-state leak would manifest).
function whoamiServer(delayMs = 0) {
  return new MockUpstream("svc", [
    {
      name: "whoami",
      description: "Return the caller's identity as seen by the upstream.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        if (delayMs) await delay(delayMs);
        return { seenBearer: ctx?.bearer ?? null };
      },
    },
  ]);
}

// POST a single JSON-RPC tools/call directly (stateless mode needs no initialize).
// The streamable-HTTP server replies as SSE; extract the JSON-RPC payload.
async function callWhoami(port: number, headers: Record<string, string>): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "call_tool", arguments: { id: "svc:whoami", args: {} } },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  assert.ok(line, `no SSE data line in response: ${JSON.stringify(text)}`);
  const msg = JSON.parse(line.slice("data:".length).trim());
  assert.ok(!msg.error, `JSON-RPC error: ${JSON.stringify(msg.error)}`);
  return msg.result.structuredContent.output.seenBearer;
}

test("pool: server construction is O(1), not per-request (sequential reuse)", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer()], cache: false });
  await winnow.init();
  const count = { n: 0 };
  const server = await serveHttp(winnow, {
    port: 0,
    resolveAuth: forwardHeaderAuth({ svc: "x-svc-auth" }),
    _serverFactory: () => {
      count.n++;
      return createGateway(winnow, {});
    },
  });
  const port = (server.address() as AddressInfo).port;

  // 15 SEQUENTIAL requests. Only one is ever in flight, so the pool reuses one
  // server. (Today's per-request createGateway would build 15.)
  for (let i = 0; i < 15; i++) {
    const seen = await callWhoami(port, { "x-svc-auth": "tok-seq" });
    assert.equal(seen, "tok-seq");
    await delay(5); // let the async release settle before the next acquire
  }
  assert.ok(count.n < 15, `expected far fewer than 15 servers, built ${count.n}`);
  assert.ok(count.n <= 2, `expected ~1 server under single concurrency, built ${count.n}`);

  // Second wave builds ZERO additional servers (pure reuse).
  const before = count.n;
  for (let i = 0; i < 15; i++) {
    assert.equal(await callWhoami(port, { "x-svc-auth": "tok-seq2" }), "tok-seq2");
    await delay(5);
  }
  assert.equal(count.n, before, `second wave should build 0 servers, built ${count.n - before}`);

  server.close();
  await winnow.close();
});

test("pool: concurrent tenants never bleed auth, forcing SERVER REUSE mid-overlap", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer(25)], cache: false });
  await winnow.init();
  const count = { n: 0 };
  const server = await serveHttp(winnow, {
    port: 0,
    resolveAuth: forwardHeaderAuth({ svc: "x-svc-auth" }),
    _serverFactory: () => {
      count.n++;
      return createGateway(winnow, {});
    },
  });
  const port = (server.address() as AddressInfo).port;

  const N = 4;
  const tokens = Array.from({ length: N }, (_, i) => `tok-${i}`);
  // Run several iterations to shake out races.
  for (let iter = 0; iter < 10; iter++) {
    // WARM the pool: one sequential request releases a server back to `free`, so the
    // upcoming concurrent burst re-acquires that pooled instance mid-overlap — the
    // exact shape a "auth stored on the server object" bug would need to leak.
    await callWhoami(port, { "x-svc-auth": "tok-warm" });
    await delay(10); // let the warm server's release settle into `free`

    const before = count.n;
    // Fire N CONCURRENTLY with different bearers; the 25ms upstream delay keeps them
    // genuinely in flight together and overlapping the reused warm server.
    const seen = await Promise.all(tokens.map((t) => callWhoami(port, { "x-svc-auth": t })));
    const burstBuilt = count.n - before;
    // Reuse proof: fewer servers built than concurrent requests => a released
    // server was re-acquired while others were still in flight.
    assert.ok(burstBuilt < N, `iter ${iter}: expected reuse (built ${burstBuilt} < ${N} concurrent)`);
    // Isolation proof: every tenant still sees ITS OWN bearer despite the reuse.
    seen.forEach((s, i) => assert.equal(s, tokens[i], `iter ${iter}: tenant ${i} bled (saw ${s})`));
  }

  server.close();
  await winnow.close();
});

test("pool: malformed body gets an error response (no hang) and pool keeps serving", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer()], cache: false });
  await winnow.init();
  const server = await serveHttp(winnow, {
    port: 0,
    resolveAuth: forwardHeaderAuth({ svc: "x-svc-auth" }),
  });
  const port = (server.address() as AddressInfo).port;

  // Malformed JSON body: must get a prompt error status, not a hung socket.
  const bad = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{ this is not json",
  });
  await bad.text();
  assert.equal(bad.status, 400, "malformed body -> 400");

  // The pool is not starved: a subsequent valid request still works.
  assert.equal(await callWhoami(port, { "x-svc-auth": "tok-after" }), "tok-after");

  server.close();
  await winnow.close();
});

test("pool: no-auth request falls back to configured identity (fail-closed)", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer(25)], cache: false });
  await winnow.init();
  const server = await serveHttp(winnow, {
    port: 0,
    resolveAuth: forwardHeaderAuth({ svc: "x-svc-auth" }),
  });
  const port = (server.address() as AddressInfo).port;

  for (let iter = 0; iter < 10; iter++) {
    // Interleave an authed request with a no-header one. The no-auth request must
    // see null (configured identity), NOT the concurrent tenant's bearer.
    const [authed, none] = await Promise.all([
      callWhoami(port, { "x-svc-auth": "tok-authed" }),
      callWhoami(port, {}),
    ]);
    assert.equal(authed, "tok-authed");
    assert.equal(none, null, `iter ${iter}: no-auth request leaked a bearer`);
  }

  server.close();
  await winnow.close();
});

test("pool: concurrent burst completes without 'Already connected' errors", async () => {
  const winnow = new Winnow({ upstreams: [whoamiServer(15)], cache: false });
  await winnow.init();
  const server = await serveHttp(winnow, {
    port: 0,
    resolveAuth: forwardHeaderAuth({ svc: "x-svc-auth" }),
  });
  const port = (server.address() as AddressInfo).port;

  const tokens = Array.from({ length: 12 }, (_, i) => `tok-${i}`);
  const seen = await Promise.all(tokens.map((t) => callWhoami(port, { "x-svc-auth": t })));
  // Each response echoes ITS OWN bearer, and none threw (callWhoami asserts no
  // JSON-RPC error), proving the acquire/release ordering never double-connects.
  seen.forEach((s, i) => assert.equal(s, tokens[i]));

  server.close();
  await winnow.close();
});
