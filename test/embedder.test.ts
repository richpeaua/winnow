import { test } from "node:test";
import assert from "node:assert/strict";
import { Winnow, localEmbedder } from "../src/index.ts";
import type { Embedder } from "../src/types.ts";
import { githubServer } from "../examples/servers.ts";

// --- dependency-free: a query-time embedder failure must degrade to lexical, not throw.
test("search: embedder failing at query time degrades to lexical (no throw)", async () => {
  let built = false;
  const flaky: Embedder = {
    async embed(texts) {
      if (!built) { built = true; return texts.map(() => [0.1, 0.2, 0.3]); } // build: one vec per tool
      throw new Error("embedder worker died"); // every query embed fails
    },
  };
  const client = new Winnow({ upstreams: [githubServer()], embedder: flaky, cache: false });
  const { hybrid } = await client.init();
  assert.equal(hybrid, true, "build succeeded, so hybrid is active");

  const hits = await client.searchTools("list pull requests"); // query embed throws -> lexical fallback
  assert.ok(hits.length > 0, "still returns results");
  assert.equal(hits[0]!.id, "github:list_pull_requests", "lexical still finds the right tool");
  await client.close();
});

test("localEmbedder: empty input returns no vectors without spawning a worker", async () => {
  const emb = localEmbedder();
  assert.deepEqual(await emb.embed([]), []);
  await emb.close(); // no-op (worker never started)
});

// --- real model: opt-in only (downloads ~90MB on first run). Set WINNOW_TEST_EMBEDDER=1.
test("localEmbedder: real off-thread hybrid search (opt-in)", { skip: process.env.WINNOW_TEST_EMBEDDER !== "1" }, async () => {
  const embedder = localEmbedder();
  const client = new Winnow({ upstreams: [githubServer()], embedder, cache: false });
  const { hybrid } = await client.init();
  assert.equal(hybrid, true, "worker embedder produced vectors");

  // A paraphrase with no lexical overlap should still land the CI tool via semantics.
  const hits = await client.searchTools("check the latest continuous integration builds");
  assert.ok(hits.some((h) => h.id === "github:list_workflow_runs"), "semantic hit found");
  await client.close(); // terminates the embedder worker via Winnow.close()
});
