// Sandbox worker: runs synchronous QuickJS-WASM. Host calls block the worker on
// Atomics.wait; the main thread fills the SharedArrayBuffer and notifies. Because
// every host call is synchronous from QuickJS's view, the WASM never suspends and
// job-pumping is safe. No ambient capabilities are injected.
//
// Persistent (pooled): QuickJS inits ONCE, then the worker loops on `job` messages,
// running each in a FRESH context (disposed after) for isolation. The SAB is
// allocated per-worker (workerData) and reused; code/tools/limits arrive per job.
//
// Plain .mjs (not .ts) on purpose: worker entry points must load natively across
// Node versions (a TS loader does not reliably apply to a Worker entry on Node 20).
import { parentPort, workerData } from "node:worker_threads";

const { sab } = workerData;
const ctrl = new Int32Array(sab, 0, 4);
const data = new Uint8Array(sab, 16);
const decoder = new TextDecoder();

/** Synchronous bridge to the main thread's async client.call. */
function hostCall(id, argsJson) {
  Atomics.store(ctrl, 0, 0);
  parentPort.postMessage({ type: "call", id, args: JSON.parse(argsJson) });
  Atomics.wait(ctrl, 0, 0);
  const len = Atomics.load(ctrl, 1);
  return decoder.decode(data.subarray(0, len));
}

const camel = (s) => s.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());

function prelude(tools) {
  const byServer = new Map();
  for (const t of tools) (byServer.get(t.server) ?? byServer.set(t.server, []).get(t.server)).push(t);
  let mcp = "const mcp = {";
  for (const [server, ts] of byServer) {
    mcp += `${JSON.stringify(server)}:{`;
    for (const t of ts) mcp += `${JSON.stringify(camel(t.name))}:(a)=>call(${JSON.stringify(t.id)},a),`;
    mcp += "},";
  }
  mcp += "};";
  return (
    `const call = (id, args) => {` +
    `  const r = JSON.parse(__mcpCall(id, JSON.stringify(args || {})));` +
    `  if (r.isError) throw new Error(typeof r.output === "string" ? r.output : JSON.stringify(r.output));` +
    `  return r.output;` +
    `};` + mcp
  );
}

/** Run one job in a fresh QuickJS context; dispose it before returning. */
function runJob(QuickJS, job) {
  const vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(job.memoryMb * 1024 * 1024);
  const deadline = Date.now() + job.timeoutMs;
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);

  const hostFn = vm.newFunction("__mcpCall", (idH, argsH) => {
    const out = hostCall(vm.getString(idH), vm.getString(argsH));
    return vm.newString(out);
  });
  hostFn.consume((f) => vm.setProp(vm.global, "__mcpCall", f));

  // Async wrapper so user code may use `await`; resolved synchronously since every
  // host call blocks (no WASM suspension), so executePendingJobs cannot deadlock.
  const wrapped = `(async () => { ${prelude(job.tools)}\n return await (async () => {\n${job.code}\n})(); })()`;

  try {
    const result = vm.evalCode(wrapped, "exec.js");
    const promise = vm.unwrapResult(result);
    let state = vm.getPromiseState(promise);
    let guard = 0;
    while (state.type === "pending" && guard++ < 100000) {
      vm.runtime.executePendingJobs();
      state = vm.getPromiseState(promise);
    }
    if (state.type === "fulfilled") {
      const value = vm.dump(state.value);
      state.value.dispose();
      parentPort.postMessage({ type: "done", value });
    } else if (state.type === "rejected") {
      const err = vm.dump(state.error);
      state.error.dispose();
      parentPort.postMessage({ type: "error", message: typeof err === "object" ? JSON.stringify(err) : String(err) });
    } else {
      parentPort.postMessage({ type: "error", message: "exec did not settle" });
    }
    promise.dispose();
  } catch (e) {
    parentPort.postMessage({ type: "error", message: String(e?.message ?? e) });
  } finally {
    vm.dispose();
  }
}

const { getQuickJS } = await import("quickjs-emscripten");
const QuickJS = await getQuickJS();

parentPort.on("message", (msg) => {
  if (msg?.type === "job") runJob(QuickJS, msg);
});
// Signal the pool this worker has initialized QuickJS and can take jobs.
parentPort.postMessage({ type: "ready" });
