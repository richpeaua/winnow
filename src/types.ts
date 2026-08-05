// Core types for the mcp-client SDK. See docs/DESIGN.md.

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
}

/** Static per-tool result-filter policy (from config). */
export interface ResultFilterPolicy {
  project?: string;
  maxTokens?: number;
  truncate?: "head" | "tail" | "smart";
  paginate?: boolean;
}

/** Pluggable embedding backend. Absent/unavailable => lexical-only search. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** Approximate token counter; injectable so we don't hard-depend on a tokenizer. */
export type TokenCounter = (text: string) => number;
