---
id: F1
title: Design the deterministic result-filter layer
type: grilling
labels: [wayfinder:ticket, wayfinder:grilling]
status: closed
assignee: lpeaua
blocked_by: []
map: map.md
---
## Question

How does a raw tool result get trimmed before it reaches context? Decide (static policy + agent override, per the framing):
- Projection language for both config policy and agent override — JMESPath vs jq vs JSONPath (feed from prior-art survey); one language for both.
- The static per-tool policy schema in config: default projection, size caps (bytes/tokens), truncation strategy, pagination/`nextCursor` handling.
- The agent-override API at call time and the precedence rule (override replaces? narrows? is bounded by the cap?).
- Non-JSON / mixed content (text blocks, images, resource links): what filtering even means there, and the safe default.
- Headless safety: the default when the agent supplies nothing must never leak an unbounded result.

Output: the filter config schema + override semantics + defaults.

## Resolution

**Projection language — JMESPath** (`@jmespath-community/jmespath`, pure JS, per R2) for both config policy and agent override — one language everywhere. jq/node-jq rejected (shells to a binary; breaks the sealed/headless goal); JSONPath rejected (weak at reshaping).

**Pipeline order per tool result:** `select source → project → cap → annotate`.
1. **Source:** prefer `structuredContent` when present (per R1); else the `content[]` blocks.
2. **Project:** apply the JMESPath expression (override if supplied, else the tool's static policy, else identity).
3. **Cap:** enforce a hard size ceiling (default e.g. 2k tokens / configurable) — truncate with a marker.
4. **Annotate:** if anything was truncated/dropped, append a short machine-readable note (`_truncated: {...}`) so the agent knows to paginate or re-project rather than assume it saw everything.

**Static per-tool policy (config):** `{ project?: <jmespath>, maxTokens?: number, truncate?: 'head'|'tail'|'smart', paginate?: boolean }`. Lives under each server's tool config (hooks into G1).

**Agent override + precedence:** `call(id, args, { project?, maxTokens? })`. Override **replaces** the default projection, but **the size cap is a hard ceiling the agent cannot raise** (it may only lower it). This is the headless-safety invariant: even a forgotten/absent projection can never leak an unbounded result — the global default cap always applies.

**Default when nothing supplied:** identity projection + global default cap. Never unbounded.

**Non-JSON / mixed content:**
- Text blocks → truncation cap applies.
- **Images/audio (base64) → replaced with a reference stub by default** (`{type:'image', bytes, mime, omitted:true}`); dumping base64 into context is a massive bloat source. Opt-in to include.
- `resource_link` → kept as-is (already a lightweight reference).
- `isError:true` results bypass projection but still honor the cap (surface the error, don't hide it).

**Why this serves the goal:** result-bloat is the gap existing gateways ignore (R2). A deterministic, always-on cap + projection means raw multi-KB tool responses are trimmed to the few fields the agent asked for *before* they ever touch context, with a hard floor of safety that holds even when the agent does nothing.
