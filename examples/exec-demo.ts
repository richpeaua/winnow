// Demo of the exec path: compose many tool calls in-sandbox, return only a tiny
// result. The 30 fat PRs never leave the sandbox — only the summary hits context.
// Run: npx tsx examples/exec-demo.ts
import { Winnow, approxTokens } from "../src/index.ts";
import { githubServer, slackServer } from "./servers.ts";

const tk = (v: unknown) => approxTokens(JSON.stringify(v));

const client = new Winnow({ upstreams: [githubServer(), slackServer()] });
await client.init();

const raw = await (githubServer()).callTool("list_pull_requests", {});
console.log(`raw github:list_pull_requests would be ${tk(raw.structuredContent)} tok in context.\n`);

const res = await client.exec(`
  const prs = await mcp.github.listPullRequests({ state: "open" });
  const stale = prs.filter(p => (p.requested_reviewers || []).length === 0);
  for (const p of stale) {
    await mcp.slack.createMessage({ channel: "eng", text: "#" + p.number + " " + p.title });
  }
  return { posted: stale.length, titles: stale.map(p => "#" + p.number + " " + p.title) };
`);

console.log("exec composed list-PRs -> filter-stale -> post-each-to-slack, returned:");
console.log(" ", JSON.stringify(res.output));
console.log(`\nfinal return to context: ${res.tokens} tok  (vs ${tk(raw.structuredContent)} raw -> ${(tk(raw.structuredContent) / res.tokens).toFixed(0)}x)`);

await client.close();
