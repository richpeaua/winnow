// F1 result-filter: select source -> project -> cap -> annotate.
// The one invariant: the size cap is a hard ceiling the agent can only lower.
import { search as jmespath } from "@jmespath-community/jmespath";
import type { CallOpts, FilteredResult, ResultFilterPolicy, ToolResult, TokenCounter } from "./types.js";

export const DEFAULT_MAX_TOKENS = 2000;

/** Default approximate counter (~4 chars/token). Inject a real tokenizer for exact caps. */
export const approxTokens: TokenCounter = (t) => Math.ceil(t.length / 4);

/** Pick the JSON payload to operate on: structuredContent, else text content, else the raw result. */
function selectSource(raw: ToolResult | unknown): unknown {
  if (raw && typeof raw === "object") {
    const r = raw as ToolResult;
    if (r.structuredContent !== undefined) return r.structuredContent;
    if (Array.isArray(r.content)) {
      // Replace heavy base64 blobs with reference stubs; keep text.
      const blocks = r.content.map((b) =>
        b.type === "image" || b.type === "audio"
          ? { type: b.type, mimeType: b.mimeType, bytes: (b.data?.length ?? 0), omitted: true }
          : b
      );
      // Collapse a pure-text result to its text for easier projection.
      if (blocks.every((b) => b.type === "text")) return blocks.map((b: any) => b.text).join("\n");
      return blocks;
    }
  }
  return raw;
}

/** Largest k in [0,n] with sizeOf(k) <= budget, where sizeOf is monotonic nondecreasing.
 *  Seeds the search with `estimate` and expands a tight bracket geometrically so every
 *  measured point sits near the (small) answer instead of at n/2 of the whole payload.
 *  Precondition (holds in the truncate branch): sizeOf(0) <= budget < sizeOf(n). The
 *  result is EXACT — the estimate only changes which points are measured, never the answer. */
function largestFitting(n: number, budget: number, sizeOf: (k: number) => number, estimate: number): number {
  if (n <= 0) return 0;
  const est = Math.max(1, Math.min(n - 1, estimate));
  let lo: number, hi: number;
  if (sizeOf(est) <= budget) {
    // Answer is >= est. Grow the upper bound until it overflows.
    lo = est;
    hi = Math.min(n, Math.ceil(est * 1.5) + 1);
    while (hi < n && sizeOf(hi) <= budget) { lo = hi; hi = Math.min(n, hi * 2); }
  } else {
    // Answer is < est. Shrink the lower bound until it fits.
    hi = est;
    lo = Math.max(0, Math.floor(est * 0.5));
    while (lo > 0 && sizeOf(lo) > budget) { hi = lo; lo = lo >> 1; }
  }
  // Invariant: sizeOf(lo) <= budget < sizeOf(hi). Binary-search the boundary exactly.
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (sizeOf(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Cap a value to `maxTokens` (exact, measured). Returns the (possibly truncated) value
 *  plus `tokens` = count(JSON.stringify(returnedValue)) so callers never re-tokenize it. */
function capTokens(value: unknown, maxTokens: number, count: TokenCounter): { value: unknown; truncated: boolean; kept?: number; dropped?: number; tokens: number } {
  const json = JSON.stringify(value) ?? "";
  const totalTokens = count(json); // the payload's one and only full tokenization
  if (totalTokens <= maxTokens) return { value, truncated: false, tokens: totalTokens };
  // Reserve headroom for the ~20-token truncation note, but only when the ceiling can
  // afford it — for a tiny ceiling the whole cap goes to CONTENT (and budget stays >= 0).
  // filterResult drops the note if it still won't fit. Floor: nothing smaller than an
  // empty container ([]/"") is representable, so when maxTokens < count(empty container)
  // — i.e. maxTokens=0 for a 1-token-per-empty counter like approxTokens — the output is
  // that empty container and its own token cost is the unavoidable floor (issue #31).
  const NOTE_RESERVE = 20;
  const budget = maxTokens > NOTE_RESERVE ? maxTokens - NOTE_RESERVE : maxTokens;
  if (Array.isArray(value)) {
    // Seed the element-count search near the fitting size (tokens spread evenly over elements),
    // then confirm every accepted prefix with an exact measurement.
    const kEst = Math.floor((value.length * budget) / totalTokens);
    const lo = largestFitting(
      value.length,
      budget,
      (k) => count(JSON.stringify(value.slice(0, k))),
      kEst
    );
    const kept = value.slice(0, lo);
    return { value: kept, truncated: true, kept: lo, dropped: value.length - lo, tokens: count(JSON.stringify(kept)) };
  }
  // Binary-search the longest string prefix that fits, seeded by a chars/token ratio.
  // (Slicing to maxTokens*4 chars only holds for the ~4char/token approximation and
  // overshoots badly with an injected tokenizer on dense text like JSON.)
  const s = typeof value === "string" ? value : json;
  const estChars = Math.floor((budget / totalTokens) * s.length);
  const lo = largestFitting(
    s.length,
    budget,
    // Measure the serialized prefix — reported cost is count(JSON.stringify(value)), and JSON
    // escaping (quotes/newlines) inflates a JSON-ish text blob well past its raw length.
    (k) => count(JSON.stringify(s.slice(0, k))),
    estChars
  );
  const prefix = s.slice(0, lo);
  return { value: prefix, truncated: true, tokens: count(JSON.stringify(prefix)) };
}

export function filterResult(
  raw: ToolResult | unknown,
  opts: CallOpts & { policy?: ResultFilterPolicy } = {},
  count: TokenCounter = approxTokens,
  /** Context-facing default cap. Pass Infinity for in-sandbox intermediates (never hit context). */
  globalCeiling: number = DEFAULT_MAX_TOKENS
): FilteredResult {
  const policy = opts.policy ?? {};
  const isError = !!(raw && typeof raw === "object" && (raw as ToolResult).isError);

  // Hard ceiling: min of global cap and any configured/override cap. Override may only lower.
  const ceiling = Math.min(
    globalCeiling,
    policy.maxTokens ?? globalCeiling,
    opts.maxTokens ?? globalCeiling
  );

  const source = selectSource(raw);
  const projection = opts.project ?? policy.project;
  // Errors bypass projection (surface them) but still honor the cap.
  const projected = !isError && projection ? jmespath(source as any, projection) : source;

  const capped = capTokens(projected, ceiling, count);
  let note = capped.truncated ? { _truncated: { kept: capped.kept, dropped: capped.dropped } } : undefined;
  // Reuse capTokens' measured count of the returned value (issue #23); only the note is extra.
  let tokens = capped.tokens + (note ? count(JSON.stringify(note)) : 0);
  // Backstop (issue #31): if the note would push output over the ceiling (tiny ceiling, or a
  // freak oversized dropped-count note), drop it so output alone honors the hard cap.
  if (note && tokens > ceiling) { note = undefined; tokens = capped.tokens; }
  return { output: capped.value, tokens, truncated: capped.truncated, note, isError };
}
