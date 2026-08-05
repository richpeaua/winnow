// End-to-end demo: search -> loadTool -> call, showing the anti-bloat path.
// Run: npm run demo
import { McpClient, META_TOOLS, approxTokens } from "../src/index.ts";
import { githubServer, slackServer } from "./servers.ts";

const tk = (v: unknown) => approxTokens(JSON.stringify(v));

const client = new McpClient({ upstreams: [githubServer(), slackServer()] });
const info = await client.init();
console.log(`initialized: ${info.tools} tools, hybrid search: ${info.hybrid}, skipped: [${info.skipped}]\n`);

console.log(`Model's tool surface: ${META_TOOLS.length} meta-tools (${META_TOOLS.map((m) => m.name).join(", ")})`);
console.log(`  vs naive: ${info.tools} full schemas would be injected up front.\n`);

// 1. search (paraphrase — exercises search)
const hits = await client.searchTools("show me open PRs that still need a review");
console.log("search 'show me open PRs that still need a review' -> top hits:");
for (const h of hits.slice(0, 3)) console.log(`  ${h.score.toFixed(2)}  ${h.id}  — ${h.summary}`);

const top = hits[0]!;
// 2. loadTool (only now do we pay for a full schema)
const [def] = client.loadTool(top.id);
console.log(`\nloaded full schema for ${def!.id} (${tk(def)} tok)`);

// 3. call with a projection — raw vs filtered
const raw = (githubServer() as any).tools?.[0]; // for size reference only
const filtered = await client.call(top.id, { state: "open" }, {
  project: "[].{number: number, title: title, url: _links.html.href, updated_at: updated_at, reviewers: requested_reviewers[].login}",
});
// measure the raw payload the naive path would have injected
const rawResult = await (githubServer()).callTool("list_pull_requests", {});
console.log(`\ncall ${top.id}:`);
console.log(`  raw result:      ${tk(rawResult.structuredContent)} tok`);
console.log(`  filtered result: ${filtered.tokens} tok  (truncated: ${filtered.truncated})`);
console.log(`  reduction: ${(tk(rawResult.structuredContent) / filtered.tokens).toFixed(1)}x`);
console.log(`  sample:`, JSON.stringify((filtered.output as any[])?.slice(0, 2)));

await client.close();
