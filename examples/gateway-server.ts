// The gateway entrypoint a host launches (this is what `mcp-winnow gateway` will
// run once packaged, P3). It aggregates upstream MCP servers behind Winnow and
// serves the 4 meta-tools over stdio. IMPORTANT: never write to stdout here —
// MCP stdio is JSON-RPC only; diagnostics must go to stderr.
import { Winnow } from "../src/index.ts";
import { StdioUpstream } from "../src/upstream/stdio.ts";
import { serveStdio } from "../src/gateway/index.ts";

// Demo config: aggregate the reference "everything" server. In real use this
// comes from winnow.config (the upstream servers to hide behind the gateway).
const winnow = new Winnow({
  upstreams: [new StdioUpstream("everything", { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] })],
});

await winnow.init();
process.stderr.write("[winnow-gateway] initialized; serving 4 meta-tools over stdio\n");
await serveStdio(winnow);
