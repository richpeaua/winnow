// P1 (part A): on-disk catalog cache. Lets a second process reuse a warm index
// without re-listing (and, on a full cache hit, without connecting at all).
// One file per server, keyed by a hash of the server's identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolDef } from "./types.js";

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface CacheEntry {
  identity: string;
  server: string;
  tools: ToolDef[];
  cachedAt: number;
  ttlMs?: number;
}

export function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "winnow");
}

export class CatalogCache {
  constructor(private dir: string = defaultCacheDir()) {}

  private file(identity: string): string {
    const key = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
    return path.join(this.dir, `${key}.json`);
  }

  read(identity: string): CacheEntry | null {
    try {
      const entry = JSON.parse(fs.readFileSync(this.file(identity), "utf8")) as CacheEntry;
      return entry.identity === identity ? entry : null;
    } catch {
      return null;
    }
  }

  /** A cache entry is fresh if within its own ttlMs (or the caller's default). */
  isFresh(entry: CacheEntry, defaultTtlMs: number, now: number): boolean {
    return now - entry.cachedAt < (entry.ttlMs ?? defaultTtlMs);
  }

  write(identity: string, server: string, tools: ToolDef[], now: number, ttlMs?: number): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const entry: CacheEntry = { identity, server, tools, cachedAt: now, ttlMs };
    fs.writeFileSync(this.file(identity), JSON.stringify(entry));
  }
}
