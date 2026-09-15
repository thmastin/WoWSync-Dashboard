// Storage abstraction. Kept deliberately narrow so the SQLite implementation
// (sqliteStore.ts) could be swapped for another engine later without
// touching the importer, diff engine, API layer, or UI.

import type { ParsedSnapshot, VersionOrUnknown } from "./types.ts";
import type { SnapshotDiff } from "./diff.ts";
import type { AccountFacts } from "./accountFacts.ts";

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

export interface SnapshotStore {
  importSnapshot(raw: string): ImportResult;
  listVersions(): VersionSummary[];
  listCharacters(version: VersionOrUnknown): StoredCharacterSummary[];
  getCharacter(identityKey: string): StoredCharacterSummary | undefined;
  listSnapshots(identityKey: string): StoredSnapshot[];
  getSnapshot(id: number): StoredSnapshot | undefined;
  recentChanges(version: VersionOrUnknown, limit?: number): RecentChange[];
  /** The deterministic account-level facts layer for one version space. `now` defaults to the wall clock but can be pinned for deterministic tests. */
  buildAccountFacts(version: VersionOrUnknown, now?: number): AccountFacts;
  close(): void;
}
