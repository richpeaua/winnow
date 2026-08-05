// Prod smoke test: run the BUILT gateway with plain `node` (no tsx), from a
// config file, and drive it — including run_code, to prove the sandbox worker
// resolves from dist. This is what `npx -y mcp-winnow gateway` will do.
// Run: npm run build && npx tsx examples/gateway-dist-smoke.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/gateway/cli.js", "--config", "examples/winnow.config.json"],
});
const host = new Client({ name: "dist-smoke", version: "1.0.0" }, { capabilities: {} });
await host.connect(transport);

const { tools } = await host.listTools();
console.log(`built gateway (node dist) exposes: ${tools.map((t) => t.name).join(", ")}`);

const c: any = await host.callTool({ name: "call_tool", arguments: { id: "everything:echo", args: { message: "from built dist" } } });
console.log(`call_tool -> ${JSON.stringify(c.structuredContent?.output)}`);

const r: any = await host.callTool({ name: "run_code", arguments: { code: `
  const a = await mcp.everything.echo({ message: "sandbox" });
  return a + " (composed in dist worker)";
` } });
console.log(`run_code -> ${JSON.stringify(r.structuredContent?.output)}`);

await host.close();
console.log("\nbuilt-from-dist gateway + sandbox worker: OK");
process.exit(0);
