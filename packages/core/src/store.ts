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
  totalMoneyCopper: number;
  charactersWithKnownGold: number;
  totalPlayedSeconds: number;
  charactersWithKnownPlaytime: number;
  lastUpdatedAt?: number;
}

export interface RecentChange {
  characterId: number;
  identityKey: string;
  characterName: string;
  version: VersionOrUnknown;
  snapshotId: number;
  importedAt: number;
  diff: SnapshotDiff;
}

export interface ImportResult {
  character: StoredCharacterSummary;
  snapshot: StoredSnapshot;
  previousSnapshot?: StoredSnapshot;
  diff?: SnapshotDiff;
  isFirstSnapshot: boolean;
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
