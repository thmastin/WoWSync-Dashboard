// Snapshot chronology: the single definition of "which snapshot is newer".
//
// The question that matters is "when did the game state actually exist" -
// the export's own `Generated` timestamp - not "when did we happen to import
// it". An export whose Generated value is missing/unknown (`Generated: ?`)
// falls back to its import time, the only observation time we have for it.
// A state cannot have been observed AFTER it was imported, so the import time
// is also a ceiling: an export whose Generated value lies in the future (a
// wrong clock on the machine that made it) is treated as observed when it was
// imported. Without that ceiling one such export would outrank every real
// export imported afterwards, stay "current" and "recent" indefinitely, and
// the only recovery would be deleting the character. (Real exports are
// generated seconds BEFORE they are imported, so the ceiling never changes
// their order.) Ties (WOWSYNC timestamps have one-second resolution, and two
// different exports can share one) are broken by row id, i.e. true insertion
// order.
//
// Everything that orders snapshots - the SQLite queries behind "latest" and
// "previous", recent changes, AccountContext's transition history - uses
// this one rule so the store, the facts layer and the LLM context can never
// describe different snapshot pairs.

/** The moment a snapshot's game state existed (seconds since the Unix epoch). */
export function snapshotObservedAt(generatedAt: number | null | undefined, importedAt: number): number {
  return Math.min(generatedAt ?? importedAt, importedAt);
}

/**
 * The same ordering as `snapshotObservedAt` + id, as a SQL ORDER BY clause
 * (newest first). Columns are those of the `snapshots` table.
 */
export const SNAPSHOTS_NEWEST_FIRST_SQL = "MIN(COALESCE(generated_at, imported_at), imported_at) DESC, id DESC";

/**
 * Normalises an export for duplicate detection only: line endings and
 * leading/trailing whitespace, i.e. what copy/paste routinely changes (the
 * parser applies the same normalisation before parsing). Never used to
 * rewrite what is stored - the raw export is kept verbatim.
 */
export function normalizeExportText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim();
}
