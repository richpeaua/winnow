import { test } from "node:test";
import assert from "node:assert/strict";
import { Winnow, filterResult, DEFAULT_MAX_TOKENS, approxTokens } from "../src/index.ts";
import { githubServer, slackServer } from "../examples/servers.ts";

test("filter: JMESPath projection trims a fat result", () => {
  const raw = { structuredContent: [{ a: 1, b: "x".repeat(100) }, { a: 2, b: "y".repeat(100) }] };
  const out = filterResult(raw, { project: "[].a" });
  assert.deepEqual(out.output, [1, 2]);
  assert.equal(out.truncated, false);
});

test("filter: cap is a hard ceiling the agent can only lower", () => {
  const big = { structuredContent: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "z".repeat(20) })) };
  // agent tries to raise the cap above the global default -> ignored
  const out = filterResult(big, { maxTokens: 999999 });
  assert.ok(out.truncated, "should truncate");
  assert.ok(approxTokens(JSON.stringify(out.output)) <= DEFAULT_MAX_TOKENS, "must not exceed global cap");
  assert.ok((out.note as any)?._truncated?.dropped > 0, "annotates dropped count");
});

test("filter: text-blob cap honors an injected tokenizer (not the 4char/token approximation)", () => {
  // A dense text result (JSON-ish string) where real tokens/char >> 1/4.
  const blob = { content: [{ type: "text", text: JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ k: i }))) }] };
  // A "real" tokenizer that is ~2x denser than the 4char/token default.
  const denseCounter = (t: string) => Math.ceil(t.length / 2);
  const out = filterResult(blob, { maxTokens: 300 }, denseCounter);
  assert.ok(out.truncated, "should truncate");
  assert.ok(denseCounter(JSON.stringify(out.output)) <= 300, `must honor the injected counter's budget (got ${out.tokens})`);
});

test("filter: base64 image blocks are stubbed, not dumped", () => {
  const raw = { content: [{ type: "image", mimeType: "image/png", data: "A".repeat(10000) }] };
  const out = filterResult(raw);
  assert.equal((out.output as any[])[0].omitted, true);
  assert.ok(out.tokens < 100, "image bytes must not flood context");
});

test("client: search -> loadTool -> call end-to-end", async () => {
  const client = new Winnow({ upstreams: [githubServer(), slackServer()] });
  const info = await client.init();
  assert.ok(info.tools >= 6);

  const hits = await client.searchTools("post a message to a slack channel");
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.id === "slack:create_message"), "right tool in results");

  const [def] = client.loadTool("slack:create_message");
  assert.equal(def!.id, "slack:create_message");

  const res = await client.call("slack:create_message", { channel: "C1", text: "hi" }, { project: "{ok: ok}" });
  assert.deepEqual(res.output, { ok: true });
  await client.close();
});

test("client: fat call is filtered below the cap", async () => {
  const client = new Winnow({ upstreams: [githubServer()] });
  await client.init();
  const res = await client.call("github:list_pull_requests", { state: "open" }, {
    project: "[].{number: number, title: title}",
  });
  assert.ok(res.tokens < DEFAULT_MAX_TOKENS);
  assert.ok(Array.isArray(res.output) && (res.output as any[]).length > 0);
  await client.close();
});

test("client: unknown tool id fails fast", async () => {
  const client = new Winnow({ upstreams: [githubServer()] });
  await client.init();
  await assert.rejects(() => client.call("github:nope", {}), /unknown tool id/);
  await client.close();
});

test("exec: composes many calls in-sandbox, returns only a small result", async () => {
  const client = new Winnow({ upstreams: [githubServer(), slackServer()] });
  await client.init();
  // list 30 fat PRs, keep only stale (no reviewers) in-sandbox, return count + titles
  const res = await client.exec(`
    const prs = await mcp.github.listPullRequests({ state: "open" });
    const stale = prs.filter(p => (p.requested_reviewers || []).length === 0);
    return { staleCount: stale.length, titles: stale.map(p => p.title) };
  `);
  assert.ok(!res.isError);
  const out = res.output as any;
  assert.ok(out.staleCount > 0 && out.staleCount < 30, "filtered a subset");
  assert.equal(out.titles.length, out.staleCount);
  assert.ok(res.tokens < 500, "final return is small");
  await client.close();
});

test("exec: enforces a timeout on runaway code", async () => {
  const client = new Winnow({ upstreams: [githubServer()] });
  await client.init();
  const res = await client.exec(`while (true) {}`, { timeoutMs: 200 });
  assert.equal(res.isError, true);
  await client.close();
});

test("exec: sandbox has no ambient capabilities (no process/fetch)", async () => {
  const client = new Winnow({ upstreams: [githubServer()] });
  await client.init();
  const res = await client.exec(`return typeof process + "," + typeof fetch;`);
  assert.equal(res.output, "undefined,undefined");
  await client.close();
});
