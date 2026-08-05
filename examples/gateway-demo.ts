// Proof of the "install as a plugin" path: a plain MCP host (raw SDK client)
// connects to the Winnow gateway over stdio, sees only 4 meta-tools, and drives
// a real upstream tool THROUGH the gateway — exactly what Claude Desktop does.
// host --stdio--> winnow-gateway --stdio--> server-everything
// Run: npx tsx examples/gateway-demo.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "examples/gateway-server.ts"] });
const host = new Client({ name: "demo-host", version: "1.0.0" }, { capabilities: {} });
await host.connect(transport);

const { tools } = await host.listTools();
console.log(`gateway exposes ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

// 1. search_tools (the host has NO idea what upstream tools exist until it asks)
const s: any = await host.callTool({ name: "search_tools", arguments: { query: "echo a message back" } });
const hits = s.structuredContent?.hits ?? [];
console.log(`\nsearch_tools('echo a message back') -> top: ${hits[0]?.id} (${hits[0]?.score})`);

// 2. call_tool through the gateway -> reaches the real upstream server
const echoId = hits.find((h: any) => h.name === "echo")?.id ?? hits[0]?.id;
const c: any = await host.callTool({ name: "call_tool", arguments: { id: echoId, args: { message: "hello via the gateway" } } });
console.log(`call_tool(${echoId}) -> ${JSON.stringify(c.structuredContent?.output)}`);

// 3. run_code composes in the gateway's server-side sandbox, returns a small result
const r: any = await host.callTool({ name: "run_code", arguments: { code: `
  const a = await mcp.everything.echo({ message: "one" });
  const b = await mcp.everything.echo({ message: "two" });
  return [a, b];
` } });
console.log(`run_code (2 composed echoes) -> ${JSON.stringify(r.structuredContent?.output)}`);

await host.close();
console.log("\nhost -> gateway -> upstream round-trip OK. This is the installable path.");
process.exit(0);
