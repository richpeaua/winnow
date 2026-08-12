// Core types for the mcp-winnow SDK. See docs/DESIGN.md.

/** A full tool definition, held internally by the SDK (never dumped to the model wholesale). */
export interface ToolDef {
  /** Stable id: `${server}:${name}`. */
  id: string;
  server: string;
  name: string;
  description: string;
  /** JSON Schema (2020-12) for the tool's arguments. */
  inputSchema: unknown;
  outputSchema?: unknown;
  /** Optional author-supplied synonyms to lift lexical search recall (see bench/recall.js). */
  aliases?: string[];
}

/** The minimal at-rest entry a search hit puts in the model's context (~20-40 tokens). */
export interface CatalogEntry {
  id: string;
  name: string;
  summary: string;
  server: string;
}

export interface SearchHit extends CatalogEntry {
  /** Normalized 0-1 relevance; low scores are the cue to `listTools` instead of guessing. */
  score: number;
}

/** A raw MCP tool result (subset of the spec's CallToolResult). */
export interface ToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface FilteredResult {
  output: unknown;
  /** Token count of `output` (+ note) as it will hit context. */
  tokens: number;
  truncated: boolean;
  note?: unknown;
  isError?: boolean;
}

export interface CallOpts {
  /** JMESPath projection to reshape/trim the result. */
  project?: string;
  /** Hard token cap; may only LOWER the server/global default, never raise it. */
  maxTokens?: number;
  /** Per-upstream auth override (multi-tenant passthrough), keyed by server name. */
  auth?: Record<string, CallContext>;
}

/** Static per-tool result-filter policy (from config). */
export interface ResultFilterPolicy {
  project?: string;
  maxTokens?: number;
  truncate?: "head" | "tail" | "smart";
  paginate?: boolean;
}

/** Per-call auth override for an upstream, for multi-tenant passthrough: the
 *  identity a single tool call should act as, overriding the upstream's configured
 *  auth. Keyed by server name in CallOpts.auth. Applies to HTTP upstreams; stdio
 *  upstreams have a process-level identity and ignore it. */
export interface CallContext {
  /** Bearer token to use for this call (sets Authorization: Bearer <token>). */
  bearer?: string;
  /** Extra/override request headers for this call (HTTP upstreams). */
  headers?: Record<string, string>;
}

/** Pluggable embedding backend. Absent/unavailable => lexical-only search. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  /** Flat-vector fast path: a contiguous Float32Array (N*dim, row-major) + its
   *  dim. Optional — SearchIndex prefers it (no number[][] alloc) and falls back
   *  to embed() when absent. */
  embedFlat?(texts: string[]): Promise<{ data: Float32Array; dim: number }>;
  /** Stable id of the embedding config (model/pooling/normalize/dtype). Present
   *  enables the on-disk vector sidecar (issue #21); absent disables caching. */
  fingerprint?: string;
  /** Optional cleanup (e.g. terminate a worker). Winnow.close() calls it if present. */
  close?(): Promise<void>;
}

/** Approximate token counter; injectable so we don't hard-depend on a tokenizer. */
export type TokenCounter = (text: string) => number;
