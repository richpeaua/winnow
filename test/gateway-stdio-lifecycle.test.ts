// Regression for issue #16: the stdio gateway must terminate when its client
// closes stdin (EOF). A warm upstream child keeps Node's event loop alive, so
// without an explicit EOF shutdown the gateway lingers after disconnect and
// hangs any client that waits for the server process to exit (e.g. a Go MCP
// client's cmd.Wait()). The reference JS SDK client masked this by not waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A minimal stdio MCP leaf: one tool, resolved from the repo's own SDK install.
const LEAF = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "leaf", version: "0.0.1" });
s.tool("ping", "ping", { v: z.string().optional() }, async ({ v }) => ({ content: [{ type: "text", text: "pong:" + (v ?? "") }] }));
await s.connect(new StdioServerTransport());
`;

test("gateway (stdio): exits when the client closes stdin after a real call", async () => {
  // Under repoRoot so the leaf's ESM imports resolve the repo's own SDK install
  // (Node ESM resolves relative to the file, ignoring NODE_PATH).
  const dir = mkdtempSync(join(repoRoot, ".eof-"));
  const leafPath = join(dir, "leaf.mjs");
  const cfgPath = join(dir, "winnow.config.json");
  writeFileSync(leafPath, LEAF);
  writeFileSync(cfgPath, JSON.stringify({
    servers: { leaf: { transport: "stdio", command: process.execPath, args: [leafPath] } },
  }));

  // detached: own process group, so cleanup can SIGKILL the whole group and the
  // grandchild leaf can't orphan when the gateway is killed on a failure path.
  const gw = spawn(
    process.execPath,
    [join(repoRoot, "node_modules/.bin/tsx"), join(repoRoot, "src/gateway/cli.ts"), "--config", cfgPath],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "inherit"], detached: true },
  );

  const send = (o: unknown) => gw.stdin.write(JSON.stringify(o) + "\n");
  // Wait for the id:2 tools/call RESULT and capture it. Gating on the content
  // (not merely "a response with id 2 arrived") guarantees a real upstream child
  // was actually spawned — otherwise a leaf that failed to load would still yield
  // an id:2 isError response and the childless gateway would exit on its own,
  // silently green-passing even with the fix reverted.
  const gotCallResult = new Promise<any>((resolve) => {
    let buf = "";
    gw.stdout.on("data", (c) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { const m = JSON.parse(line); if (m.id === 2) resolve(m); }
      }
    });
  });

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "call_tool", arguments: { id: "leaf:ping", args: { v: "x" } } } });

  const callMsg = await gotCallResult;
  // The upstream really answered (proves a warm child exists to keep the loop alive).
  assert.equal(callMsg.result?.isError ?? false, false, "call_tool should succeed (leaf must be warm)");
  assert.equal(callMsg.result?.content?.[0]?.text, "pong:x", "result must come from the real upstream leaf");

  const exited = new Promise<number>((resolve) => gw.on("exit", (code) => resolve(code ?? -1)));
  gw.stdin.end(); // EOF — this is what a disconnecting client does

  try {
    const code = await Promise.race([
      exited,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("gateway did not exit within 8s of stdin EOF (issue #16 regression)")), 8000).unref()),
    ]);
    assert.equal(code, 0, "gateway should exit 0 on stdin EOF");
  } finally {
    try { process.kill(-gw.pid!, "SIGKILL"); } catch { /* group already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
