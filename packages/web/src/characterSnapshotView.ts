// Pure helpers for the character-page snapshot picker.
// Cards already follow the selected snapshot; the header used to always show
// the character's *latest* level/class. That lied when a historical snapshot
// was selected (product review gap 17 / N6). These helpers keep header + banner
// aligned with the same selection the cards use.
// Snapshots from the API are newest-first: index 0 is the latest observation.

import type { StoredCharacterSummary, StoredSnapshot } from "./types.ts";

export function latestSnapshotId(snapshots: ReadonlyArray<{ id: number }>): number | null {
  return snapshots[0]?.id ?? null;
}

/** True when the selected row is not the newest observation (list[0]). */
export function isViewingHistoricalSnapshot(
  selectedId: number | null | undefined,
  snapshots: ReadonlyArray<{ id: number }>,
): boolean {
  const latest = latestSnapshotId(snapshots);
  if (latest == null || selectedId == null) return false;
  return selectedId !== latest;
}

/** Observation time for a stored snapshot: export Generated, else import time. */
export function snapshotObservationAt(snapshot: { generatedAt?: number; importedAt: number }): number {
  return snapshot.generatedAt ?? snapshot.importedAt;
}

export interface CharacterHeaderView {
  className: string;
  level: number | string;
  realm: string;
  faction?: string;
  /** Epoch seconds for the sync-age line (selected snapshot when one is shown). */
  syncedAt?: number;
  snapshotCount: number;
  viewingHistorical: boolean;
}

/**
 * Header fields for the character page. When a snapshot is selected, class /
 * level / faction / realm / sync age come from that snapshot; otherwise fall
 * back to the character summary (latest).
 */
export function characterHeaderView(
  character: StoredCharacterSummary,
  snapshot: StoredSnapshot | undefined,
  snapshots: ReadonlyArray<StoredSnapshot>,
): CharacterHeaderView {
  const viewingHistorical = snapshot
    ? isViewingHistoricalSnapshot(snapshot.id, snapshots)
    : false;

  if (snapshot) {
    const c = snapshot.parsed.character;
    return {
      className: c.class ?? character.class ?? "?",
      level: c.level ?? "?",
      realm: c.realm ?? character.realm,
      faction: c.faction ?? character.faction,
      syncedAt: snapshotObservationAt(snapshot),
      snapshotCount: character.snapshotCount,
      viewingHistorical,
    };
  }

  return {
    className: character.class ?? "?",
    level: character.latestLevel ?? "?",
    realm: character.realm,
    faction: character.faction,
    syncedAt: character.latestGeneratedAt ?? character.latestImportedAt,
    snapshotCount: character.snapshotCount,
    viewingHistorical: false,
  };
}
