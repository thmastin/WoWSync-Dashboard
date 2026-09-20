// Storage abstraction. Kept deliberately narrow so the SQLite implementation
// (sqliteStore.ts) could be swapped for another engine later without
// touching the importer, diff engine, API layer, or UI.

import type { ParsedSnapshot, VersionOrUnknown } from "./types.ts";
import type { SnapshotDiff } from "./diff.ts";
import type { AccountFacts } from "./accountFacts.ts";
import type { AccountContext } from "./accountContext.ts";

export interface StoredCharacterSummary {
  id: number;
  version: VersionOrUnknown;
  realm: string;
  name: string;
  identityKey: string;
  class?: string;
  faction?: string;
  latestLevel?: number;
  latestMoneyCopper?: number;
  latestPlayedSeconds?: number;
  latestGeneratedAt?: number;
  latestImportedAt?: number;
  snapshotCount: number;
}

export interface StoredSnapshot {
  id: number;
  characterId: number;
  generatedAt?: number;
  importedAt: number;
  parsed: ParsedSnapshot;
}

export interface VersionSummary {
  version: VersionOrUnknown;
  characterCount: number;
  /**
   * Sum of the known latest gold values across the version's characters.
   * ABSENT (not 0) when `charactersWithKnownGold` is 0: a sum over nothing
   * observed is "unknown", and only a character whose gold was actually
   * observed as 0 copper makes a real 0 total. Also a version-wide sum across
   * realms - for realm-partitioned versions prefer AccountFacts.realms[].
   */
  totalMoneyCopper?: number;
  charactersWithKnownGold: number;
  /** Absent (not 0) when `charactersWithKnownPlaytime` is 0 - see totalMoneyCopper. */
  totalPlayedSeconds?: number;
  charactersWithKnownPlaytime: number;
  /** The most recent OBSERVATION time (the export's Generated value, falling back to import time) among the version's latest snapshots. */
  lastUpdatedAt?: number;
}

export interface RecentChange {
  characterId: number;
  identityKey: string;
  characterName: string;
  version: VersionOrUnknown;
  snapshotId: number;
  importedAt: number;
  /** When the latest snapshot's game state existed (export Generated time, else import time). Recent changes are ranked by this, not by import time. */
  observedAt: number;
  diff: SnapshotDiff;
}

export interface ImportResult {
  character: StoredCharacterSummary;
  /** The stored snapshot for this export. For a duplicate, the EXISTING snapshot - nothing new was stored. */
  snapshot: StoredSnapshot;
  /** The chronologically preceding snapshot (older observation), if any. Absent for a duplicate and when this export is the oldest observation. */
  previousSnapshot?: StoredSnapshot;
  /** Diff from `previousSnapshot` to this snapshot, forward in time. Absent (never a reversed or "no change" placeholder) when there is nothing older to compare. */
  diff?: SnapshotDiff;
  /** True only when the character had no snapshots at all before this import. */
  isFirstSnapshot: boolean;
  /** True when this exact export (same character, same Generated value, same text) was already stored: nothing was inserted or changed. */
  isDuplicate: boolean;
  /** Whether this snapshot is now the character's current (newest-observed) state. False when an older export was imported after a newer one. */
  isLatest: boolean;
}

/** What a successful character deletion removed. Counts are read from the rows actually deleted, not estimated. */
export interface DeleteCharacterResult {
  identityKey: string;
  version: VersionOrUnknown;
  realm: string;
  name: string;
  snapshotsDeleted: number;
}

export interface SnapshotStore {
  /**
   * Imports one export. Idempotent: the same export twice is a no-op
   * (`isDuplicate`). Snapshots are ordered by observation time, so an older
   * export imported later becomes history, not current state. Atomic: a
   * failure leaves neither a partial snapshot nor a snapshot-less character.
   */
  importSnapshot(raw: string): ImportResult;
  /**
   * Permanently removes one character and every snapshot stored for it
   * (atomically - all or nothing). Returns what was removed, or undefined
   * when no character has that identity key (already deleted / never
   * existed) - a safe no-op, never an error. Identity keys embed
   * version+realm+name, so other versions/realms/characters are untouched.
   * Everything derived (AccountFacts, AccountContext, recent changes, ...)
   * is computed from the remaining rows, so it reflects the deletion on
   * its next computation with nothing further to invalidate.
   */
  deleteCharacter(identityKey: string): DeleteCharacterResult | undefined;
  listVersions(): VersionSummary[];
  listCharacters(version: VersionOrUnknown): StoredCharacterSummary[];
  getCharacter(identityKey: string): StoredCharacterSummary | undefined;
  listSnapshots(identityKey: string): StoredSnapshot[];
  getSnapshot(id: number): StoredSnapshot | undefined;
  recentChanges(version: VersionOrUnknown, limit?: number): RecentChange[];
  /** The deterministic account-level facts layer for one version space. `now` defaults to the wall clock but can be pinned for deterministic tests. */
  buildAccountFacts(version: VersionOrUnknown, now?: number): AccountFacts;
  /** The full, all-versions deterministic export used by the "Export Dashboard Context" developer tool. `now` defaults to the wall clock but can be pinned for deterministic tests. */
  buildAccountContext(now?: number): AccountContext;
  close(): void;
}
