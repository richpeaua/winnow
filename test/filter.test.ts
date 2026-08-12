// Tokenization-cost tests for the result filter (issues #23 + #24).
// These use an *instrumented* TokenCounter that records how many times it is called
// and how many chars it tokenized, so we can assert WHERE/HOW-OFTEN we tokenize
// without ever relaxing the hard-ceiling acceptance check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterResult, approxTokens } from "../src/index.ts";

/** Wrap a base counter, recording invocation count and total chars tokenized. */
function instrument(base: (t: string) => number = approxTokens) {
  const stats = { calls: 0, chars: 0 };
  const count = (t: string) => { stats.calls++; stats.chars += t.length; return base(t); };
  return { count, stats };
}

/** Reference implementation of the OLD exact array truncation (largest fitting prefix). */
function refKeptArray(arr: unknown[], ceiling: number, count: (t: string) => number): number {
  if (count(JSON.stringify(arr)) <= ceiling) return arr.length;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (count(JSON.stringify(arr.slice(0, mid))) <= ceiling - 20) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Reference implementation of the OLD exact string truncation (longest fitting prefix). */
function refKeptString(s: string, ceiling: number, count: (t: string) => number): number {
  if (count(JSON.stringify(s)) <= ceiling) return s.length;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (count(JSON.stringify(s.slice(0, mid))) <= ceiling - 20) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Monotonic-but-NON-linear counter: each digit costs 3, every other char costs 1.
 *  Still nondecreasing in prefix length (each added char adds >= 1), so the exact
 *  binary search stays valid — but the chars/token ratio no longer predicts the
 *  boundary, which (with skewed payloads) throws the seed estimate off. */
function digitWeighted(t: string): number {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    n += c >= 48 && c <= 57 ? 3 : 1;
  }
  return n;
}

// ---- #23: under-cap tokenizes the payload exactly once ---------------------

test("#23 under-cap: the payload is tokenized exactly once (note not added)", () => {
  const source = Array.from({ length: 20 }, (_, i) => ({ i, tag: "small" }));
  const raw = { structuredContent: source };
  const { count, stats } = instrument();
  const out = filterResult(raw, { maxTokens: 1000 }, count, 2000);

  assert.equal(out.truncated, false, "should fit under the cap");
  assert.equal(out.note, undefined, "no truncation note when not truncated");
  assert.equal(stats.calls, 1, `payload must be tokenized exactly once (was ${stats.calls})`);
  // Reported tokens equal a single independent measurement of the output.
  assert.equal(out.tokens, approxTokens(JSON.stringify(out.output)));
});

// ---- #23/#24: reported tokens are correct (under-cap AND truncated) --------

test("#23/#24 reported tokens = count(output) + (truncated ? count(note) : 0)", () => {
  const cases: Array<{ raw: unknown; maxTokens: number }> = [
    { raw: { structuredContent: Array.from({ length: 10 }, (_, i) => ({ i })) }, maxTokens: 1000 }, // under-cap
    { raw: { structuredContent: Array.from({ length: 5000 }, (_, i) => ({ i, pad: "z".repeat(20) })) }, maxTokens: 300 }, // array truncate
    { raw: { structuredContent: "q".repeat(50000) }, maxTokens: 250 }, // string truncate
  ];
  for (const { raw, maxTokens } of cases) {
    const out = filterResult(raw, { maxTokens }, approxTokens, 2000);
    const expected =
      approxTokens(JSON.stringify(out.output)) +
      (out.truncated ? approxTokens(JSON.stringify(out.note)) : 0);
    assert.equal(out.tokens, expected, `tokens mismatch (truncated=${out.truncated})`);
  }
});

// ---- #24: the hard invariant — output NEVER exceeds the ceiling ------------

test("#24 invariant: truncated output never exceeds the ceiling (property)", () => {
  const payloads: Array<{ name: string; source: unknown }> = [
    { name: "large uniform array", source: Array.from({ length: 8000 }, (_, i) => ({ i, pad: "abc" })) },
    { name: "one giant string", source: "x".repeat(400_000) },
    { name: "varied-size elements", source: Array.from({ length: 4000 }, (_, i) => ({ i, blob: "y".repeat((i % 40) * 5) })) },
    { name: "500KB array -> handful", source: Array.from({ length: 2000 }, (_, i) => ({ i, big: "Z".repeat(250) })) },
  ];
  const ceilings = [80, 200, 500, 1000];
  for (const { name, source } of payloads) {
    for (const ceiling of ceilings) {
      const out = filterResult({ structuredContent: source }, { maxTokens: ceiling }, approxTokens, 2000);
      const measured = approxTokens(JSON.stringify(out.output));
      assert.ok(measured <= ceiling, `${name}@${ceiling}: output ${measured} tok exceeds ceiling`);
    }
  }
});

// ---- #24: kept/dropped parity with the old exact binary search -------------

test("#24 parity: new truncation keeps exactly the same element count as old search", () => {
  const sources: unknown[][] = [
    Array.from({ length: 5000 }, (_, i) => ({ i, pad: "z".repeat(20) })),
    Array.from({ length: 3000 }, (_, i) => ({ i, blob: "y".repeat((i % 50) * 4) })),
    Array.from({ length: 2000 }, (_, i) => ({ i, big: "Z".repeat(250) })),
  ];
  for (const source of sources) {
    for (const ceiling of [120, 300, 700]) {
      const out = filterResult({ structuredContent: source }, { maxTokens: ceiling }, approxTokens, 2000);
      const expectedKept = refKeptArray(source, ceiling, approxTokens);
      assert.ok(out.truncated, "expected truncation for these payloads");
      assert.equal((out.note as any)._truncated.kept, expectedKept,
        `kept mismatch @${ceiling}: got ${(out.note as any)._truncated.kept}, ref ${expectedKept}`);
    }
  }
});

// ---- #24: fewer tokenizations on a large truncating payload ----------------

test("#24 cost: total chars tokenized stays well under 3x the payload size", () => {
  const source = Array.from({ length: 2000 }, (_, i) => ({ i, big: "Z".repeat(250) }));
  const payloadSize = JSON.stringify(source).length; // ~500KB
  const ceiling = 300; // keeps only a handful of elements

  const { count: newCount, stats: newStats } = instrument();
  filterResult({ structuredContent: source }, { maxTokens: ceiling }, newCount, 2000);

  // Old approach: ~log2(n) full-prefix measurements near n/2 => ~2x the whole payload.
  const { count: oldCount, stats: oldStats } = instrument();
  refKeptArray(source, ceiling, oldCount);

  assert.ok(newStats.chars < 3 * payloadSize,
    `new tokenized ${newStats.chars} chars, want < ${3 * payloadSize} (payload ${payloadSize})`);
  assert.ok(newStats.chars < oldStats.chars,
    `new (${newStats.chars}) should tokenize materially fewer chars than old (${oldStats.chars})`);
});

// ---- #24: force the seeded bracket's grow / shrink loops -------------------
// The geometric expansion in largestFitting only fires when the ratio estimate lands
// OUTSIDE the initial [floor(est*0.5), ceil(est*1.5)] window. Uniform payloads + a
// linear counter never trigger it, so these use SKEWED payloads whose per-element cost
// differs sharply between head and tail, driving the estimate far from the true boundary.

// GROW path: tiny head, huge tail. The huge tail inflates totalTokens, so tokens/element
// is over-estimated => kEst UNDER-shoots the true (large) kept count => grow loop must run.
const growSource: unknown[] = Array.from({ length: 2000 }, (_, i) =>
  i < 1900 ? { i } : { i, big: "Z".repeat(1000) }
);
// SHRINK path: huge head, tiny tail. tokens/element is under-estimated => kEst OVER-shoots
// the true (small) kept count => shrink loop must run.
const shrinkSource: unknown[] = Array.from({ length: 2000 }, (_, i) =>
  i < 30 ? { i, big: "Z".repeat(1000) } : { i }
);

for (const [name, source, expandsUp] of [
  ["grow (tiny-head/huge-tail)", growSource, true],
  ["shrink (huge-head/tiny-tail)", shrinkSource, false],
] as const) {
  for (const counter of [approxTokens, digitWeighted] as const) {
    for (const ceiling of [200, 600, 1500]) {
      test(`#24 bracket ${name} @${ceiling} [${counter === approxTokens ? "linear" : "nonlinear"}]: parity + invariant + loop fired`, () => {
        const out = filterResult({ structuredContent: source }, { maxTokens: ceiling }, counter, 4000);
        const kept = (out.note as any)?._truncated?.kept ?? source.length;
        const ref = refKeptArray(source, ceiling, counter);

        // (a) exact parity vs the old binary search (same counter).
        assert.equal(kept, ref, `kept parity: got ${kept}, ref ${ref}`);
        // (b) the hard invariant.
        assert.ok(counter(JSON.stringify(out.output)) <= ceiling, "output must fit the ceiling");

        // (c) PROVE the loop ran: recompute the same seed the impl uses and show the true
        // boundary sits OUTSIDE the initial window, so grow/shrink was required for correctness.
        const total = counter(JSON.stringify(source));
        const kEst = Math.floor((source.length * (ceiling - 20)) / total);
        if (out.truncated) {
          if (expandsUp) {
            assert.ok(kept > Math.ceil(kEst * 1.5) + 1,
              `grow must fire: kept ${kept} should exceed initial hi ${Math.ceil(kEst * 1.5) + 1} (kEst ${kEst})`);
          } else {
            assert.ok(kept < Math.floor(kEst * 0.5),
              `shrink must fire: kept ${kept} should be below initial lo ${Math.floor(kEst * 0.5)} (kEst ${kEst})`);
          }
        }
      });
    }
  }
}

// ---- #24: string-truncate parity (linear AND non-linear counter) ----------

test("#24 string parity: truncated prefix length matches old char binary search", () => {
  // A skewed string: a long digit run (weight 3 under digitWeighted) then letters,
  // so the chars/token estimate is off for the non-linear counter too.
  const skewed = "1234567890".repeat(4000) + "x".repeat(40000);
  const strings = ["q".repeat(50000), skewed];
  for (const s of strings) {
    for (const counter of [approxTokens, digitWeighted] as const) {
      for (const ceiling of [150, 400, 900]) {
        const out = filterResult({ structuredContent: s }, { maxTokens: ceiling }, counter, 4000);
        const ref = refKeptString(s, ceiling, counter);
        assert.equal((out.output as string).length, ref,
          `string kept mismatch @${ceiling}: got ${(out.output as string).length}, ref ${ref}`);
        assert.ok(counter(JSON.stringify(out.output)) <= ceiling, "string output must fit the ceiling");
      }
    }
  }
});

// ---- #24: degenerate / early-return paths ---------------------------------

test("#24 single oversized element -> keeps 0, output [] fits", () => {
  const source = [{ big: "Z".repeat(5000) }, { i: 2 }, { i: 3 }];
  const ceiling = 100; // element 0 alone (~1254 tok) blows budget (80)
  const out = filterResult({ structuredContent: source }, { maxTokens: ceiling }, approxTokens, 2000);
  assert.equal(out.truncated, true);
  assert.equal((out.note as any)._truncated.kept, 0, "no whole element fits");
  assert.deepEqual(out.output, []);
  assert.ok(approxTokens(JSON.stringify(out.output)) <= ceiling, "empty output fits the ceiling");
});

test("#24 empty array and empty string: early-return, not truncated", () => {
  const arr = filterResult({ structuredContent: [] }, { maxTokens: 50 }, approxTokens, 2000);
  assert.equal(arr.truncated, false);
  assert.deepEqual(arr.output, []);
  assert.equal(arr.tokens, approxTokens(JSON.stringify([])));

  const str = filterResult({ structuredContent: "" }, { maxTokens: 50 }, approxTokens, 2000);
  assert.equal(str.truncated, false);
  assert.equal(str.output, "");
  assert.equal(str.tokens, approxTokens(JSON.stringify("")));
});
