// Real tokenizer for honest counts. gpt-tokenizer (cl100k) is a pure-JS proxy;
// absolute Claude counts differ ~10-20%, but the REDUCTION RATIOS we care about
// are stable across tokenizers. Documented caveat, not a hidden one.
import { encode } from "gpt-tokenizer";

export function countTokens(text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  return encode(text).length;
}
