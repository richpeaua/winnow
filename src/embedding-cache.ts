// P1 (part C, issue #21): on-disk embedding sidecar. Hybrid init is ~99.7%
// embedding, and none of it was cached — a full catalog cache hit still re-embedded
// every tool. This persists per-tool vectors in a flat little-endian Float32 `.bin`
// beside the catalog cache so a warm start reindexes from disk with ZERO embedder-
// worker loads (~1.78s -> ~5ms @200 tools). Correctness is guarded by two hashes:
//   - fingerprint (whole file): sha256(version | model | pooling | normalize | dtype).
//     A model/config change mints a different file, so stale vectors are never read.
//   - textHash (per tool): sha256(indexText(tool)). If a tool's indexed fields change,
//     that one tool misses and is re-embedded; everything else stays a hit.
// dim is NOT in the fingerprint (it isn't known until the model runs); instead it is
// stored in the manifest and validated against the .bin byte length on read, so a
// truncated/mismatched file degrades to a full miss rather than corrupt vectors.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { defaultCacheDir } from "./cache.js";

/** Bump to invalidate every sidecar on disk. Bump on a file-format change OR on
 *  any change to the embedding math that the fingerprint fields (model/pooling/
 *  normalize/dtype) don't already capture — e.g. editing embedder-worker.mjs. */
export const EMBED_CACHE_VERSION = 1;

export interface EmbedFingerprintInput {
  model: string;
  pooling: string;
  normalize: boolean;
  dtype?: string;
}

/** Stable id of an embedding config; two embedders with the same fingerprint
 *  produce interchangeable vectors, so they may share a sidecar. */
export function fingerprintFor(o: EmbedFingerprintInput): string {
  return crypto
    .createHash("sha256")
    .update([EMBED_CACHE_VERSION, o.model, o.pooling, String(o.normalize), o.dtype ?? ""].join("|"))
    .digest("hex");
}

/** Hash of the exact text a tool's vector depends on (search.ts indexText). */
export function embedTextHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface ManifestEntry {
  id: string;
  textHash: string;
  /** Row index into the flat vector array (byte offset = offset * dim * 4). */
  offset: number;
}
interface Manifest {
  fingerprint: string;
  dim: number;
  entries: ManifestEntry[];
}

/** Vectors read back from disk, keyed by tool id. `vec` is a view over the
 *  loaded buffer (length === dim); copy it (or splat via set) before the buffer
 *  is dropped. */
export interface CachedVectors {
  byId: Map<string, { textHash: string; vec: Float32Array }>;
  dim: number;
}

export interface VectorRow {
  id: string;
  textHash: string;
  vec: Float32Array; // length === dim
}

export class EmbeddingCache {
  constructor(private dir: string = defaultCacheDir()) {}

  private base(fingerprint: string): string {
    return path.join(this.dir, `emb-${fingerprint.slice(0, 32)}`);
  }

  /** Load the sidecar for this fingerprint, or null if absent/mismatched/corrupt. */
  read(fingerprint: string): CachedVectors | null {
    const base = this.base(fingerprint);
    try {
      const m = JSON.parse(fs.readFileSync(`${base}.json`, "utf8")) as Manifest;
      if (m.fingerprint !== fingerprint || !Number.isInteger(m.dim) || m.dim <= 0) return null;
      const buf = fs.readFileSync(`${base}.bin`);
      if (buf.byteLength % 4 !== 0) return null;
      // Zero-parse: view the file bytes as Float32 directly (little-endian, which
      // is every platform Node ships on). readFileSync may hand back a pooled
      // Buffer, so honor byteOffset.
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (f32.length !== m.entries.length * m.dim) return null; // truncated / dim drift
      const byId = new Map<string, { textHash: string; vec: Float32Array }>();
      for (const e of m.entries) {
        byId.set(e.id, { textHash: e.textHash, vec: f32.subarray(e.offset * m.dim, (e.offset + 1) * m.dim) });
      }
      return { byId, dim: m.dim };
    } catch {
      return null;
    }
  }

  /** Persist `rows`, merging with any existing sidecar for this fingerprint so
   *  vectors written by another catalog sharing the dir survive (one vector per
   *  id; the newest write for an id wins). Note: merge keeps ids not in `rows`,
   *  so a shared sidecar grows with the union of tool ids ever seen under this
   *  fingerprint (~1.5KB/tool) — bounded in practice, no eviction path. */
  write(fingerprint: string, dim: number, rows: VectorRow[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const merged = new Map<string, { textHash: string; vec: Float32Array }>();
    const existing = this.read(fingerprint);
    if (existing && existing.dim === dim) {
      // Copy out of the read buffer — it is dropped before we serialize.
      for (const [id, e] of existing.byId) merged.set(id, { textHash: e.textHash, vec: Float32Array.from(e.vec) });
    }
    for (const r of rows) merged.set(r.id, { textHash: r.textHash, vec: r.vec });

    const ids = [...merged.keys()];
    const bin = new Float32Array(ids.length * dim);
    const entries: ManifestEntry[] = ids.map((id, i) => {
      bin.set(merged.get(id)!.vec, i * dim);
      return { id, textHash: merged.get(id)!.textHash, offset: i };
    });
    const base = this.base(fingerprint);
    const manifest: Manifest = { fingerprint, dim, entries };
    // Write each file to a unique temp path then rename (atomic on the same fs),
    // so a concurrent reader never catches a half-written file. .bin first, then
    // the manifest, so a readable manifest never points past a shorter .bin.
    // (read() still length-validates the pair, so even a torn pair degrades to a
    // re-embed, never corrupt vectors.)
    this.atomicWrite(`${base}.bin`, Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
    this.atomicWrite(`${base}.json`, Buffer.from(JSON.stringify(manifest)));
  }

  private atomicWrite(dest: string, data: Buffer): void {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  }
}
