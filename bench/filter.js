// The F1 result-filter, as specified: select source -> project -> cap -> annotate.
import { search as jmespath } from "@jmespath-community/jmespath";
import { countTokens } from "./tokenize.js";

const DEFAULT_MAX_TOKENS = 2000;

// Trim a JSON value to <= maxTokens by dropping array tail (spec: truncate + annotate).
function capTokens(value, maxTokens) {
  let json = JSON.stringify(value);
  if (countTokens(json) <= maxTokens) return { value, truncated: false };
  if (Array.isArray(value)) {
    let lo = 0, hi = value.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (countTokens(JSON.stringify(value.slice(0, mid))) <= maxTokens - 20) lo = mid;
      else hi = mid - 1;
    }
    return { value: value.slice(0, lo), truncated: true, kept: lo, dropped: value.length - lo };
  }
  // non-array: hard string cut as a fallback
  return { value: json.slice(0, maxTokens * 3), truncated: true };
}

// filterResult(rawResult, { project, maxTokens }) -> { output, tokens, note }
export function filterResult(raw, opts = {}) {
  const maxTokens = Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS); // agent can only lower
  const projected = opts.project ? jmespath(raw, opts.project) : raw;
  const capped = capTokens(projected, maxTokens);
  const output = capped.value;
  const tokens = countTokens(JSON.stringify(output));
  const note = capped.truncated ? { _truncated: { kept: capped.kept, dropped: capped.dropped } } : null;
  return { output, tokens: tokens + (note ? countTokens(JSON.stringify(note)) : 0), note };
}
