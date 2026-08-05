// Validation benchmark: measure real token cost of the naive path vs the
// mcp-client design, on a fixed representative surface. Prints reduction ratios.
import { ALL_TOOLS, META_TOOLS, SERVERS, catalogEntry, RAW_PR_LIST, TASK } from "./fixtures.js";
import { filterResult } from "./filter.js";
import { countTokens } from "./tokenize.js";

const tk = (v) => countTokens(JSON.stringify(v));
const pct = (from, to) => (((from - to) / from) * 100).toFixed(1) + "%";
const x = (from, to) => (from / to).toFixed(1) + "x";

// ---------- 1. Definitions at rest (before any work) ----------
const baselineDefs = tk(ALL_TOOLS);          // naive: every full schema in the tool list
const sdkDefsAtRest = tk(META_TOOLS);        // sdk: model sees only the 4 meta-tools

// ---------- 2. Result bloat on the fat call ----------
const rawPRTokens = tk(RAW_PR_LIST);
const filteredPR = filterResult(RAW_PR_LIST, { project: TASK.prProjection }); // call-path (static policy)
// exec-path: compose in-sandbox, return only the stale ones' one-line summaries
const staleSummaries = RAW_PR_LIST
  .filter((p) => p.requested_reviewers.length === 0)
  .map((p) => `#${p.number} ${p.title} (${p._links.html.href})`);
const execResultTokens = tk(staleSummaries);

// ---------- 3. End-to-end task ----------
// Naive: all defs + raw results for each tool call in the task.
const naiveResults = rawPRTokens + tk(TASK.slackRawResult);
const naiveTotal = baselineDefs + naiveResults;

// SDK (call-path): meta defs + searches (top-8 minimal entries each) + load_tool
// for the tools actually used + filtered results.
const topK = 8;
function searchCost(query) {
  // rank is out of scope here; cost = k minimal entries returned to the model
  const entries = ALL_TOOLS.slice(0, topK).map(catalogEntry);
  return tk(entries);
}
const searchTokens = TASK.searches.reduce((s, q) => s + searchCost(q), 0);
const usedFullDefs = ALL_TOOLS.filter((t) => TASK.usedToolIds.includes(t.name));
const loadToolTokens = tk(usedFullDefs);
const slackFiltered = filterResult(TASK.slackRawResult, { project: "{ok: ok, ts: ts}" }).tokens;

const sdkCallResults = filteredPR.tokens + slackFiltered;
const sdkCallTotal = sdkDefsAtRest + searchTokens + loadToolTokens + sdkCallResults;

// SDK (exec-path): one run_code that lists PRs, filters stale in-sandbox, posts to
// slack, returns only a small confirmation. Model sees meta defs + 1 search + result.
const sdkExecResults = execResultTokens + slackFiltered;
const sdkExecTotal = sdkDefsAtRest + searchCost(TASK.searches[0]) + loadToolTokens + sdkExecResults;

// ---------- report ----------
const line = "-".repeat(72);
console.log(line);
console.log("mcp-client design validation benchmark");
console.log(`surface: ${Object.keys(SERVERS).length} servers, ${ALL_TOOLS.length} tools | tokenizer: gpt-tokenizer cl100k (proxy)`);
console.log(line);

console.log("\n[1] DEFINITION BLOAT (at rest, before any work)");
console.log(`  naive  (all ${ALL_TOOLS.length} full schemas): ${baselineDefs.toLocaleString()} tok`);
console.log(`  sdk    (4 meta-tools):            ${sdkDefsAtRest.toLocaleString()} tok`);
console.log(`  reduction: ${pct(baselineDefs, sdkDefsAtRest)}  (${x(baselineDefs, sdkDefsAtRest)})   [spec target >=85%]`);

console.log("\n[2] RESULT BLOAT (the fat call: github:list_pull_requests, 30 PRs)");
console.log(`  raw:                 ${rawPRTokens.toLocaleString()} tok`);
console.log(`  filtered (call-path, JMESPath projection): ${filteredPR.tokens.toLocaleString()} tok  -> ${pct(rawPRTokens, filteredPR.tokens)} (${x(rawPRTokens, filteredPR.tokens)})`);
console.log(`  filtered (exec-path, in-sandbox reduce):   ${execResultTokens.toLocaleString()} tok  -> ${pct(rawPRTokens, execResultTokens)} (${x(rawPRTokens, execResultTokens)})`);
console.log(`  [spec: every result <= 2000 tok cap] call-path ${filteredPR.tokens <= 2000 ? "PASS" : "FAIL"}`);

console.log("\n[3] END-TO-END TASK (defs + search + load + results)");
console.log(`  naive total:          ${naiveTotal.toLocaleString()} tok   (defs ${baselineDefs.toLocaleString()} + results ${naiveResults.toLocaleString()})`);
console.log(`  sdk call-path total:  ${sdkCallTotal.toLocaleString()} tok   (defs ${sdkDefsAtRest} + search ${searchTokens} + load ${loadToolTokens} + results ${sdkCallResults})`);
console.log(`  sdk exec-path total:  ${sdkExecTotal.toLocaleString()} tok`);
console.log(`  reduction call-path:  ${pct(naiveTotal, sdkCallTotal)}  (${x(naiveTotal, sdkCallTotal)})   [spec target ~10x]`);
console.log(`  reduction exec-path:  ${pct(naiveTotal, sdkExecTotal)}  (${x(naiveTotal, sdkExecTotal)})`);
console.log("\n" + line);

// machine-readable summary
console.log(JSON.stringify({
  defs: { naive: baselineDefs, sdk: sdkDefsAtRest, reductionPct: +pct(baselineDefs, sdkDefsAtRest).slice(0, -1) },
  result: { raw: rawPRTokens, call: filteredPR.tokens, exec: execResultTokens },
  endToEnd: { naive: naiveTotal, sdkCall: sdkCallTotal, sdkExec: sdkExecTotal, xCall: +x(naiveTotal, sdkCallTotal).slice(0, -1), xExec: +x(naiveTotal, sdkExecTotal).slice(0, -1) },
}));
