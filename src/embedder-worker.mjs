// Embedder worker (issue #5): runs Transformers.js feature-extraction OFF the
// main event loop so hybrid search never stalls the loop that serves every other
// request. The model loads lazily on the first embed; embeds are serialized
// (one pipeline) and answered by request id. Uses the optional
// @huggingface/transformers dep — if it's absent, embeds reject and the caller
// degrades to lexical-only search.
//
// Plain .mjs (not .ts) on purpose: worker entry points must load natively across
// Node versions (a TS loader does not reliably apply to a Worker entry on Node 20).
import { parentPort, workerData } from "node:worker_threads";

const { options } = workerData;

let extractP = null;
function getExtractor() {
  if (!extractP) {
    extractP = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipeOpts = {};
      if (options.dtype) pipeOpts.dtype = options.dtype;
      return pipeline("feature-extraction", options.model, pipeOpts);
    })();
  }
  return extractP;
}

// Serialize requests: a single pipeline, run one embed at a time.
let chain = Promise.resolve();

parentPort.on("message", (msg) => {
  if (msg?.type !== "embed") return;
  chain = chain.then(async () => {
    try {
      const extract = await getExtractor();
      const out = await extract(msg.texts, { pooling: options.pooling, normalize: options.normalize });
      // Transfer the raw Float32 buffer (shape [N, dim]) with a transfer list
      // instead of materializing a number[][] via out.tolist() (measured
      // ~8ms -> ~0.02ms at N=200). The flat buffer flows worker -> sidecar ->
      // dot loop without ever building a nested array (issue #21).
      const dim = out.dims[out.dims.length - 1];
      let data = out.data; // Float32Array, length N*dim
      // Only own, exactly-sized buffers are transferable without surprises.
      if (!(data instanceof Float32Array) || data.byteOffset !== 0 || data.length * 4 !== data.buffer.byteLength) {
        data = new Float32Array(data);
      }
      parentPort.postMessage({ type: "result", id: msg.id, data, dim }, [data.buffer]);
    } catch (e) {
      parentPort.postMessage({ type: "error", id: msg.id, message: String(e?.message ?? e) });
    }
  });
});
