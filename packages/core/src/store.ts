// Storage abstraction. Kept deliberately narrow so the SQLite implementation
// (sqliteStore.ts) could be swapped for another engine later without
// touching the importer, diff engine, API layer, or UI.

import type { ParsedSnapshot, VersionOrUnknown, WowVersion } from "./types.ts";
import type { SnapshotDiff } from "./diff.ts";
import type { AccountFacts } from "./accountFacts.ts";
import type { AccountContext } from "./accountContext.ts";
import type { ItemFacetEvidence, ItemMetadataView } from "./itemMetadata.ts";
import type { SharedJournal, SharedSectionName, SharedStorageOwner, SharedStorageProjection, SkipReason } from "./sharedStorage.ts";

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

/**
 * What an import did with one shared-storage section (Warband / Guild Bank). The section itself
 * stays in the character's snapshot exactly as before; this only reports whether it was admitted
 * into the shared-storage journal (see sharedStorage.ts). Deterministic and free of storage details.
 */
export interface SharedStorageImportOutcome {
  section: SharedSectionName;
  /**
   * recorded      - a new underlying observation was journaled
   * source-added  - the observation was already known; this export was added as another source of it
   * already-known - nothing changed (this export was already a recorded source)
   * skipped       - not evidence (UNKNOWN), not attributable to an owner, or not anchored in time; see `reason`
   */
  outcome: "recorded" | "source-added" | "already-known" | "skipped";
  reason?: SkipReason;
  /** The owner the observation belongs to (e.g. "retail::warband::local"); absent when skipped. */
  ownerKey?: string;
  /** True when this import made the observation its owner's current (newest informative) state. False when it recorded an older, partial or informationless one. */
  becameCurrent?: boolean;
  /** False when the observation scanned nothing (e.g. every guild tab inaccessible): recorded, but never a current state. */
  informative?: boolean;
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
  /**
   * What the export's shared-storage sections did to the shared-storage journal, in section order
   * (Warband, then Guild). Empty for a duplicate export (nothing was imported) and for an export with no shared sections.
   */
  sharedStorage: SharedStorageImportOutcome[];
}

/** What a backfill pass over existing snapshots added. A second pass over unchanged data adds nothing. */
export interface SharedStorageBackfillResult {
  snapshotsWithSharedSections: number;
  observationsAdded: number;
  sourcesAdded: number;
  /**
   * Admissions NOT written because their owner's history was explicitly deleted after that snapshot
   * was stored (see `deleteSharedStorageOwner`). Counted so a backfill that declined to resurrect
   * deleted history says so.
   */
  suppressedByDeletion: number;
}

/**
 * What an explicit shared-storage owner deletion removed. Counts come from the rows actually
 * deleted. `existed: false` (and zero counts) means the owner had no journal history: nothing was
 * deleted and nothing was recorded.
 */
export interface DeleteSharedStorageOwnerResult {
  /** The owner's serialized key (e.g. "retail::warband::local"), as in `ImportResult.sharedStorage[].ownerKey`. */
  ownerKey: string;
  existed: boolean;
  observationsDeleted: number;
  /** Provenance rows (one per carrying export) deleted with those observations. */
  sourcesDeleted: number;
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
  /**
   * The persisted shared-storage journal (immutable observations + provenance), as the pure
   * shared-storage domain model. Character deletion never removes anything from it.
   */
  loadSharedJournal(): SharedJournal;
  /** The current state of every shared-storage owner: `projectJournal(loadSharedJournal())`. Read-time and DERIVED; nothing is cached. */
  projectSharedStorage(): SharedStorageProjection;
  /**
   * EXPLICIT, owner-scoped, destructive: deletes that one owner's entire journal history (every
   * observation and every provenance row), atomically. The caller names the owner with the typed
   * shared-storage identity (the Warband's installation-local scope, or one guild by its opaque
   * GuildClubID); nothing else identifies it and nothing is matched as a pattern.
   *
   * It is never implied by anything else: deleting a character or snapshot, a character changing
   * guild, or a newer UNKNOWN / partial / inaccessible section all leave the journal alone.
   * Character snapshots are never modified. Other owners are untouched. A missing owner is a no-op.
   *
   * Afterwards the owner has no projection. It is NOT a tombstone: any export imported later that
   * carries a valid observation admits it normally and the journal starts again from that evidence
   * (a LAST_SEEN replay the addon still holds counts as such evidence). What deletion does prevent is
   * `backfillSharedStorage` resurrecting the deleted history from snapshots that were already stored
   * (see the \`shared_owner_clears\` cutoff).
   *
   * Throws TypeError for a malformed owner (e.g. an empty or whitespace-padded GuildClubID).
   */
  deleteSharedStorageOwner(owner: SharedStorageOwner): DeleteSharedStorageOwnerResult;
  /**
   * Idempotently admits shared-storage sections of already-stored snapshots into the journal using the
   * same domain rules as import. Never alters snapshots and never removes journal rows. Runs automatically
   * once per database (a \`store_meta\` marker); safe to call again. It skips, per owner, every snapshot that
   * was already stored when that owner's history was explicitly deleted, so it can never bring deleted
   * history back; snapshots imported afterwards are ordinary evidence and are processed normally.
   */
  backfillSharedStorage(): SharedStorageBackfillResult;
  /**
   * Resolved item metadata for one game version (see itemMetadata.ts): static, game-client-reported facts per base
   * item id. ENRICHMENT: never part of a snapshot or shared-observation identity, never rewrites history, and
   * independent of character deletion. An item with no evidence is simply absent (every facet UNKNOWN). Empty for
   * the unrouted version.
   */
  listItemMetadata(version: VersionOrUnknown): ItemMetadataView[];
  /** The stored item-metadata evidence (with provenance) for one game version, for diagnostics and tests. */
  loadItemEvidence(version: WowVersion): ItemFacetEvidence[];
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
