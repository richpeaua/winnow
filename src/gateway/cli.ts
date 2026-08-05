#!/usr/bin/env node
// `mcp-winnow gateway` — start the gateway from a config file. Aggregates the
// upstream servers listed in the config behind the 4 meta-tools.
// dev:  npx tsx src/gateway/cli.ts --config winnow.config.json [--http --port 8080]
// prod: mcp-winnow gateway --config winnow.config.json   (after P3 packaging)
import fs from "node:fs";
import { Winnow } from "../client.js";
import { resolveConfig } from "../config.js";
import { serveStdio, serveHttp, forwardHeaderAuth } from "./index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const configPath = arg("--config");
if (!configPath) {
  process.stderr.write("usage: mcp-winnow gateway --config <winnow.config.json> [--http --port <n>]\n");
  process.exit(2);
}

// Resilient first-run: if the config file isn't there yet, start with no
// upstreams (the 4 meta-tools still appear) rather than crashing the server.
let raw: unknown;
try {
  raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.stderr.write(`[winnow-gateway] no config at ${configPath}; starting with no upstream servers. Create it to aggregate MCP servers.\n`);
  raw = { servers: {} };
}
const winnow = Winnow.fromConfig(raw);
const info = await winnow.init();
process.stderr.write(`[winnow-gateway] ${info.tools} tools from ${info.tools ? "config" : "?"}, hybrid=${info.hybrid}, skipped=[${info.skipped}]\n`);

if (has("--http")) {
  const port = Number(arg("--port") ?? 8080);
  const token = process.env.WINNOW_GATEWAY_TOKEN;
  // Optional multi-tenant passthrough: config.gateway.forwardAuth maps a server
  // to a request header carrying that upstream's per-agent bearer.
  const forwardAuth = resolveConfig(raw).gateway?.forwardAuth;
  const resolveAuth = forwardAuth ? forwardHeaderAuth(forwardAuth) : undefined;
  await serveHttp(winnow, { port, token, resolveAuth });
  process.stderr.write(`[winnow-gateway] Streamable-HTTP on :${port}${token ? " (bearer required)" : ""}${forwardAuth ? " (auth passthrough on)" : ""}\n`);
} else {
  await serveStdio(winnow);
}
