// File-backed holder for the private Forever knowledge bundle. Server and MCP processes read the same
// file next to the WoWSync database (or WOWSYNC_FOREVER_KNOWLEDGE_PATH). Node-only: not exported from the
// package index so the web bundle never pulls in node:fs.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ForeverKnowledgeIndex, type ForeverKnowledgeBundle } from "./foreverKnowledgeBundle.ts";

export const FOREVER_KNOWLEDGE_FILE = "forever-knowledge.json";
export const MAX_FOREVER_KNOWLEDGE_BYTES = 80 * 1024 * 1024;

export function foreverKnowledgePath(databasePath: string, override = process.env.WOWSYNC_FOREVER_KNOWLEDGE_PATH): string {
  return override && override.trim() ? override : path.join(path.dirname(databasePath), FOREVER_KNOWLEDGE_FILE);
}

export interface ForeverKnowledgeStatus {
  installed: boolean;
  path: string;
  builtAt?: string;
  counts?: { quests: number; items: number; npcs: number; itemTooltips: number; spellTooltips: number; recipeItems: number };
  sources?: Array<{ name: string; revision?: string; confidence: string }>;
  error?: string;
}

/** Validates a bundle document without trusting anything it says beyond its shape. */
export function validateForeverKnowledgeBundle(value: unknown): ForeverKnowledgeBundle {
  const bundle = value as ForeverKnowledgeBundle;
  if (!bundle || typeof bundle !== "object" || bundle.schema !== 2 || bundle.version !== "forever") throw new TypeError("Expected a Forever knowledge bundle (schema 2, version forever).");
  for (const key of ["quests", "items", "npcs", "objects", "zones", "recipesByProfession", "recipeItems"] as const) if (!bundle[key] || typeof bundle[key] !== "object") throw new TypeError(`Bundle is missing ${key}.`);
  if (!bundle.tooltips || typeof bundle.tooltips.items !== "object" || typeof bundle.tooltips.spells !== "object") throw new TypeError("Bundle is missing tooltips.");
  if (!Array.isArray(bundle.sources)) throw new TypeError("Bundle is missing sources.");
  return bundle;
}

export class ForeverKnowledgeStore {
  private cached?: { mtimeMs: number; size: number; index: ForeverKnowledgeIndex };
  private lastError?: string;
  readonly file: string;
  constructor(file: string) { this.file = file; }

  /** The current index, reloaded when the file changes; undefined when absent or invalid. */
  get(): ForeverKnowledgeIndex | undefined {
    if (!existsSync(this.file)) { this.cached = undefined; return undefined; }
    const stat = statSync(this.file);
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) return this.cached.index;
    try {
      const index = new ForeverKnowledgeIndex(validateForeverKnowledgeBundle(JSON.parse(readFileSync(this.file, "utf8"))));
      this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, index };
      this.lastError = undefined;
      return index;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  status(): ForeverKnowledgeStatus {
    const index = this.get();
    if (!index) return { installed: false, path: path.basename(this.file), ...(this.lastError ? { error: this.lastError } : {}) };
    const bundle = index.bundle;
    return {
      installed: true, path: path.basename(this.file), builtAt: bundle.builtAt,
      counts: { quests: Object.keys(bundle.quests).length, items: Object.keys(bundle.items).length, npcs: Object.keys(bundle.npcs).length, itemTooltips: Object.keys(bundle.tooltips.items).length, spellTooltips: Object.keys(bundle.tooltips.spells).length, recipeItems: Object.keys(bundle.recipeItems).length },
      sources: bundle.sources.map(({ name, revision, confidence }) => ({ name, revision, confidence })),
    };
  }

  /** Validates and atomically replaces the bundle file. */
  install(text: string): ForeverKnowledgeStatus {
    if (Buffer.byteLength(text, "utf8") > MAX_FOREVER_KNOWLEDGE_BYTES) throw new TypeError("Knowledge bundle is too large.");
    const bundle = validateForeverKnowledgeBundle(JSON.parse(text));
    new ForeverKnowledgeIndex(bundle);
    const temp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.file);
    this.cached = undefined;
    return this.status();
  }
}
