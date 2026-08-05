// Proof: drive a REAL MCP server over stdio through the SDK.
// Runs the reference "everything" server via npx. Requires network for the
// first npx fetch. Run: npx tsx examples/real-stdio.ts
import { McpClient } from "../src/index.ts";
import { StdioUpstream } from "../src/upstream/stdio.ts";

const everything = new StdioUpstream("everything", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
});

const client = new McpClient({ upstreams: [everything] });
const info = await client.init();
console.log(`connected to real server: ${info.tools} tools discovered\n`);

const hits = await client.searchTools("echo a message back to me");
console.log("search 'echo a message back to me' -> top 3:");
for (const h of hits.slice(0, 3)) console.log(`  ${h.score.toFixed(2)}  ${h.id} — ${h.summary}`);

const echoId = hits.find((h) => h.name === "echo")?.id ?? hits[0]!.id;
const [def] = client.loadTool(echoId);
console.log(`\nloaded schema for ${def!.id}`);

const res = await client.call(echoId, { message: "hello from mcp-client" });
console.log(`\ncall ${echoId} -> ${res.tokens} tok, output:`, JSON.stringify(res.output));

await client.close();
console.log("\nclosed. real stdio round-trip OK.");
