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
      parentPort.postMessage({ type: "result", id: msg.id, vectors: out.tolist() });
    } catch (e) {
      parentPort.postMessage({ type: "error", id: msg.id, message: String(e?.message ?? e) });
    }
  });
});
