#!/usr/bin/env node
// `mcp-winnow gateway` — start the gateway from a config file. Aggregates the
// upstream servers listed in the config behind the 4 meta-tools.
// dev:  npx tsx src/gateway/cli.ts --config winnow.config.json [--http --port 8080]
// prod: mcp-winnow gateway --config winnow.config.json   (after P3 packaging)
import fs from "node:fs";
import { Winnow } from "../client.ts";
import { serveStdio, serveHttp } from "./index.ts";

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

const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const winnow = Winnow.fromConfig(raw);
const info = await winnow.init();
process.stderr.write(`[winnow-gateway] ${info.tools} tools from ${info.tools ? "config" : "?"}, hybrid=${info.hybrid}, skipped=[${info.skipped}]\n`);

if (has("--http")) {
  const port = Number(arg("--port") ?? 8080);
  const token = process.env.WINNOW_GATEWAY_TOKEN;
  await serveHttp(winnow, { port, token });
  process.stderr.write(`[winnow-gateway] Streamable-HTTP on :${port}${token ? " (bearer required)" : ""}\n`);
} else {
  await serveStdio(winnow);
}
