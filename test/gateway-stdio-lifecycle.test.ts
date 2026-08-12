// Lifecycle regressions for the stdio gateway.
//   #16: it must terminate when its client closes stdin (EOF). A warm upstream
//        child keeps Node's event loop alive, so without an explicit EOF
//        shutdown the gateway lingers and hangs any client that waits for the
//        server process to exit (e.g. a Go MCP client's cmd.Wait()).
//   #18: it must also tear upstreams down on SIGTERM/SIGINT, so a host that
//        signals the gateway (instead of closing the transport) can't orphan the
//        upstream child processes (SIGKILL to the gateway does not cascade).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A minimal stdio MCP leaf: one tool, resolved from the repo's own SDK install.
// The ref'd interval makes it a "sticky" upstream that does NOT exit on stdin
// EOF — the exact class #16/#18 are about (a trivial leaf self-terminates on EOF
// and would orphan-proof itself, hiding the bug). It dies only when its parent
// closes it (SDK client.close() -> SIGTERM), i.e. via graceful shutdown.
const LEAF = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
setInterval(() => {}, 1000); // keep the event loop alive across stdin EOF
const s = new McpServer({ name: "leaf", version: "0.0.1" });
s.tool("ping", "ping", { v: z.string().optional() }, async ({ v }) => ({ content: [{ type: "text", text: "pong:" + (v ?? "") }] }));
await s.connect(new StdioServerTransport());
`;

/** How many processes currently match `pattern` in their command line (via pgrep -f). */
function countProcs(pattern: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", pattern], (err, stdout) => {
      // pgrep exits 1 with no match -> zero.
      resolve(err ? 0 : stdout.trim().split("\n").filter(Boolean).length);
    });
  });
}

/** Spawn the real gateway CLI over a warm stdio upstream and drive it until the
 *  upstream has actually answered a call_tool (so a real warm child exists).
 *  Returns the child, its unique leaf path, and a cleanup fn. detached: own
 *  process group so cleanup can SIGKILL the whole group on a failure path. */
async function startWarmGateway() {
  const dir = mkdtempSync(join(repoRoot, ".life-")); // under repoRoot so leaf ESM resolves the repo SDK
  const leafPath = join(dir, "leaf.mjs");
  const cfgPath = join(dir, "winnow.config.json");
  writeFileSync(leafPath, LEAF);
  writeFileSync(cfgPath, JSON.stringify({
    servers: { leaf: { transport: "stdio", command: process.execPath, args: [leafPath] } },
  }));

  // Note: launched via tsx, which forwards signals to the child node process that
  // actually installs the SIGTERM/SIGINT handlers — the #18 test's signal targets
  // gw.pid and relies on that forwarding (verified against tsx 4.x).
  const gw = spawn(
    process.execPath,
    [join(repoRoot, "node_modules/.bin/tsx"), join(repoRoot, "src/gateway/cli.ts"), "--config", cfgPath],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "inherit"], detached: true },
  );
  const send = (o: unknown) => gw.stdin.write(JSON.stringify(o) + "\n");
  // Built before warm-up so a failed warm-up (thrown assert, or an id:2 that never
  // arrives) still reaps the detached group (incl. the sticky leaf) and the temp
  // dir instead of leaking a forever-running process. SIGKILL of the pgid reaps
  // the leaf even after the gateway has exited (it inherits the gateway's group).
  const cleanup = () => {
    try { process.kill(-gw.pid!, "SIGKILL"); } catch { /* group already gone */ }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    // Resolve on the id:2 RESULT and capture it. Gating on content (not merely
    // "id:2 arrived") guarantees a real upstream child was spawned — a leaf that
    // failed to load would still yield an id:2 isError response, letting a
    // childless gateway exit on its own and silently green-pass a reverted fix.
    const callMsg: any = await Promise.race([
      new Promise((resolve) => {
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
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "call_tool", arguments: { id: "leaf:ping", args: { v: "x" } } } });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("gateway never returned the id:2 call result (warm-up failed)")), 8000).unref()),
    ]);
    assert.equal(callMsg.result?.isError ?? false, false, "call_tool should succeed (leaf must be warm)");
    assert.equal(callMsg.result?.content?.[0]?.text, "pong:x", "result must come from the real upstream leaf");
  } catch (e) {
    cleanup();
    throw e;
  }
  return { gw, leafPath, send, cleanup };
}

/** Await the gateway's own exit, or reject after `ms` (the failure = still wedged). */
function exitWithin(gw: ReturnType<typeof spawn>, ms: number, why: string): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => gw.on("exit", () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(why)), ms).unref()),
  ]);
}

test("gateway (stdio): exits when the client closes stdin after a real call (#16)", async () => {
  const { gw, cleanup } = await startWarmGateway();
  try {
    const exited = new Promise<number>((resolve) => gw.on("exit", (code) => resolve(code ?? -1)));
    gw.stdin.end(); // EOF — what a disconnecting client does
    const code = await Promise.race([
      exited,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("gateway did not exit within 8s of stdin EOF (issue #16 regression)")), 8000).unref()),
    ]);
    assert.equal(code, 0, "gateway should exit 0 on stdin EOF");
  } finally {
    cleanup();
  }
});

test("gateway (stdio): SIGTERM exits and reaps the upstream child, no orphan (#18)", async () => {
  const { gw, leafPath, cleanup } = await startWarmGateway();
  try {
    assert.equal(await countProcs(leafPath), 1, "warm upstream leaf should be running before the signal");

    process.kill(gw.pid!, "SIGTERM"); // signal the gateway directly (not stdin close)
    await exitWithin(gw, 8000, "gateway did not exit within 8s of SIGTERM (issue #18)");

    // The leaf is a grandchild; SIGTERM to the gateway does not cascade, so if it
    // survives the gateway's exit it is an orphan. Graceful shutdown must reap it.
    // Poll briefly: winnow.close() closes the SDK client, which SIGTERMs the leaf.
    let remaining = 1;
    for (let i = 0; i < 30 && remaining > 0; i++) { remaining = await countProcs(leafPath); if (remaining) await sleep(200); }
    assert.equal(remaining, 0, "upstream leaf must be reaped on gateway shutdown (no orphan)");
  } finally {
    cleanup();
  }
});
