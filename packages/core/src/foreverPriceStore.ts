// File-backed holder for the Forever price bundle (forever-prices.json next to the knowledge bundle).
// Node-only, like ForeverKnowledgeStore.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ForeverPriceIndex, type ForeverPriceBundle } from "./foreverPrices.ts";

export const FOREVER_PRICES_FILE = "forever-prices.json";
export const MAX_FOREVER_PRICES_BYTES = 20 * 1024 * 1024;

export function foreverPricesPath(databasePath: string, override = process.env.WOWSYNC_FOREVER_PRICES_PATH): string {
  return override && override.trim() ? override : path.join(path.dirname(databasePath), FOREVER_PRICES_FILE);
}

export function validateForeverPriceBundle(value: unknown): ForeverPriceBundle {
  const bundle = value as ForeverPriceBundle;
  if (!bundle || typeof bundle !== "object" || bundle.schema !== 1 || bundle.version !== "forever" || bundle.source !== "AHledger") throw new TypeError("Expected a Forever price bundle (schema 1, source AHledger).");
  if (typeof bundle.fetchedAt !== "string" || !bundle.markets || typeof bundle.markets !== "object") throw new TypeError("Price bundle is missing fetchedAt or markets.");
  for (const [market, entry] of Object.entries(bundle.markets)) {
    if (!/^forever\.(normal|pvp|rp)\.(alliance|horde)\.[a-z]{2}$/.test(market)) throw new TypeError(`Unexpected market id ${market}.`);
    if (!entry || typeof entry.prices !== "object") throw new TypeError(`Market ${market} has no prices.`);
    for (const price of Object.values(entry.prices)) {
      for (const key of ["median", "minBuyout", "quantity", "median7d", "median30d", "salesPerDay"] as const) {
        const v = price[key];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new TypeError(`Invalid ${key} in ${market}.`);
      }
    }
  }
  return bundle;
}

export interface ForeverPriceStatus { installed: boolean; path: string; fetchedAt?: string; markets?: Array<{ market: string; items: number }>; error?: string }

export class ForeverPriceStore {
  private cached?: { mtimeMs: number; size: number; index: ForeverPriceIndex };
  private lastError?: string;
  readonly file: string;
  constructor(file: string) { this.file = file; }

  get(): ForeverPriceIndex | undefined {
    if (!existsSync(this.file)) { this.cached = undefined; return undefined; }
    const stat = statSync(this.file);
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) return this.cached.index;
    try {
      const index = new ForeverPriceIndex(validateForeverPriceBundle(JSON.parse(readFileSync(this.file, "utf8"))));
      this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, index };
      this.lastError = undefined;
      return index;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  status(): ForeverPriceStatus {
    const index = this.get();
    if (!index) return { installed: false, path: path.basename(this.file), ...(this.lastError ? { error: this.lastError } : {}) };
    return { installed: true, path: path.basename(this.file), fetchedAt: index.bundle.fetchedAt, markets: Object.entries(index.bundle.markets).map(([market, entry]) => ({ market, items: Object.keys(entry.prices).length })) };
  }

  install(text: string): ForeverPriceStatus {
    if (Buffer.byteLength(text, "utf8") > MAX_FOREVER_PRICES_BYTES) throw new TypeError("Price bundle is too large.");
    validateForeverPriceBundle(JSON.parse(text));
    const temp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.file);
    this.cached = undefined;
    return this.status();
  }
}
