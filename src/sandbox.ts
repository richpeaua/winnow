// X1 code-execution sandbox — STUB.
// Design (docs/DESIGN.md §6): QuickJS-WASM (quickjs-emscripten) in a
// worker_thread, capability-injected (only generated server modules + a return
// channel), every bridged __mcpCall passing through the F1 filter, output-size
// cap = the F1 global cap. Not yet wired; call()/searchTools()/loadTool() are
// the validated path. This throws clearly until the sandbox lands.
import type { FilteredResult } from "./types.ts";

export interface ExecOpts {
  timeoutMs?: number;
  memoryMb?: number;
}

export interface SandboxBridge {
  /** The capability injected into the sandbox: run one filtered MCP call. */
  call(id: string, args: unknown): Promise<FilteredResult>;
}

export async function runSandbox(_code: string, _bridge: SandboxBridge, _opts: ExecOpts = {}): Promise<FilteredResult> {
  throw new Error(
    "exec(): the QuickJS-WASM sandbox is not implemented in the skeleton. " +
    "Use call()/searchTools()/loadTool() (the validated core). See docs/DESIGN.md §6."
  );
}
