// F1 result-filter: select source -> project -> cap -> annotate.
// The one invariant: the size cap is a hard ceiling the agent can only lower.
import { search as jmespath } from "@jmespath-community/jmespath";
import type { CallOpts, FilteredResult, ResultFilterPolicy, ToolResult, TokenCounter } from "./types.ts";

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

function capTokens(value: unknown, maxTokens: number, count: TokenCounter): { value: unknown; truncated: boolean; kept?: number; dropped?: number } {
  const json = JSON.stringify(value) ?? "";
  if (count(json) <= maxTokens) return { value, truncated: false };
  if (Array.isArray(value)) {
    let lo = 0, hi = value.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (count(JSON.stringify(value.slice(0, mid))) <= maxTokens - 20) lo = mid;
      else hi = mid - 1;
    }
    return { value: value.slice(0, lo), truncated: true, kept: lo, dropped: value.length - lo };
  }
  const s = typeof value === "string" ? value : json;
  return { value: s.slice(0, maxTokens * 4), truncated: true };
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
  const note = capped.truncated ? { _truncated: { kept: capped.kept, dropped: capped.dropped } } : undefined;
  const tokens = count(JSON.stringify(capped.value) ?? "") + (note ? count(JSON.stringify(note)) : 0);
  return { output: capped.value, tokens, truncated: capped.truncated, note, isError };
}
