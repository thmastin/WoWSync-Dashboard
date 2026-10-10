import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ErpProjectConflictError, validateErpProject, type ErpProject, type ErpProjectDraft, type ErpProjectEvent } from "./erpProjects.ts";
import {
  DemandConflictError,
  storedDemandToExplicitDemand,
  validateCreateDemandInput,
  validateUpdateDemandInput,
  type CreateDemandInput,
  type DemandType,
  type ExplicitDemand,
  type StoredDemand,
  type UpdateDemandInput,
} from "./demand.ts";
import { buildAccountFacts, type AccountFacts } from "./accountFacts.ts";
import { buildAccountContext as buildAccountContextPure, type AccountContext } from "./accountContext.ts";
import { SNAPSHOTS_NEWEST_FIRST_SQL, normalizeExportText, snapshotObservedAt } from "./chronology.ts";
import { characterIdentity } from "./identity.ts";
import { diffSnapshots, type SnapshotDiff } from "./diff.ts";
import { parseWowSyncExport } from "./parser.ts";
import { mergeCharacterState, normalizeCharacterStateSidecar } from "./characterState.ts";
import { mergeForeverStructuredObservation, normalizeForeverStructuredObservation } from "./foreverGearObservation.ts";
import { DashboardReadModel } from "./readModel.ts";
import {
  canonicalJson,
  evaluateEquipmentPolicy,
  normalizeEquipmentObservation,
  type EquipmentNormalizationOutcome,
} from "./equipmentObservation.ts";
import {
  ITEM_FACETS,
  ITEM_METADATA_SOURCES,
  buildItemMetadataViews,
  knownFacets,
  mergeEvidence,
  type ItemFacetEvidence,
  type ItemFacetName,
  type ItemMetadataSource,
  type ItemMetadataView,
} from "./itemMetadata.ts";
import {
  admitExport,
  isInformativeContent,
  ownerKey,
  projectJournal,
  recordExport,
  restoreSharedObservation,
  SharedStorageIntegrityError,
  serializeSharedObservation,
  type CarrierExport,
  type CarrierState,
  type JournalEntry,
  type RecordedSection,
  type SharedJournal,
  type SharedObservationSource,
  type SharedStorageOwner,
  type SharedStorageProjection,
} from "./sharedStorage.ts";
import { UNKNOWN_VERSION, type ParsedSnapshot, type VersionOrUnknown, type WowVersion } from "./types.ts";
import {
  buildAccountCurrencies,
  characterCurrenciesView,
  currencyCarryReason,
  normalizeCurrencySection,
  pickCurrencySection,
  type AccountCurrencies,
  type CharacterCurrencies,
  type CurrencyCarryReason,
  type CurrencyImportOutcome,
  type CurrencyValues,
  type StoredCurrencySectionMeta,
} from "./wowCurrencies.ts";
import { WOW_VERSIONS, detectVersion } from "./version.ts";
import type {
  DeleteCharacterResult,
  ImportExtras,
  ImportResult,
  DeleteSharedStorageOwnerResult,
  RecentChange,
  SharedStorageBackfillResult,
  SharedStorageImportOutcome,
  SnapshotReadStore,
  SnapshotStore,
  StoredCharacterSummary,
  StoredEquipmentObservation,
  StoredSnapshot,
  VersionSummary,
} from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  realm TEXT NOT NULL,
  name TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  class TEXT,
  faction TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  generated_at INTEGER,
  imported_at INTEGER NOT NULL,
  level INTEGER,
  money_copper INTEGER,
  played_seconds INTEGER,
  level_played_seconds INTEGER,
  raw_text TEXT NOT NULL,
  parsed_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_character ON snapshots(character_id, imported_at);

-- Schema evolution is additive: every table here is IF NOT EXISTS, and one-time data work is an
-- idempotent pass guarded by a marker in store_meta (there is no migration framework).
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Shared-storage journal (see sharedStorage.ts and docs/ARCHITECTURE.md). Immutable observations of
-- storage that belongs to an OWNER (the Warband, or one guild), never to a character. There is
-- deliberately NO reference from these tables to characters or snapshots: deleting a character or a
-- snapshot must not delete, cascade into, or invalidate a shared observation.
CREATE TABLE IF NOT EXISTS shared_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  owner_key TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('warband', 'guild')),
  owner_json TEXT NOT NULL,
  claimed_observed_at INTEGER NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  content_hash TEXT NOT NULL,
  hash_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL -- audit only (when this row was written); never used for ordering
);
CREATE INDEX IF NOT EXISTS idx_shared_observations_owner ON shared_observations(owner_key);

-- Provenance: one row per (observation, carrying export). snapshot_id is a historical reference
-- WITHOUT a foreign key (AUTOINCREMENT ids are never reused, so it can never point at a different
-- snapshot); the source character's label is denormalized so it survives that character.
CREATE TABLE IF NOT EXISTS shared_observation_sources (
  observation_id INTEGER NOT NULL REFERENCES shared_observations(id),
  snapshot_id INTEGER NOT NULL,
  carrier_state TEXT NOT NULL CHECK (carrier_state IN ('OBSERVED', 'LAST_SEEN')),
  export_observed_at INTEGER NOT NULL,
  source_identity_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_realm TEXT NOT NULL,
  snapshot_visit INTEGER,
  last_visit INTEGER,
  visited_npc TEXT,
  visited_zone TEXT,
  coverage_note TEXT,
  refresh_issue TEXT,
  pending INTEGER,
  PRIMARY KEY (observation_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_sources_snapshot ON shared_observation_sources(snapshot_id);

-- Explicit owner deletion (deleteSharedStorageOwner) leaves ONE row per cleared owner: the highest snapshot
-- id ever allocated at that moment. It is a BACKFILL CUTOFF, not a tombstone: import never consults it, so
-- new evidence recreates the owner normally. Only a re-scan of snapshots that ALREADY existed
-- (backfillSharedStorage) skips that owner's admissions from them, so old stored snapshots can never
-- resurrect history the user deleted. Snapshot ids are AUTOINCREMENT (never reused), so "id <= cutoff"
-- means exactly "stored before the deletion".
CREATE TABLE IF NOT EXISTS shared_owner_clears (
  owner_key TEXT PRIMARY KEY,
  cleared_through_snapshot_id INTEGER NOT NULL,
  cleared_at INTEGER NOT NULL -- audit only
);

-- Item metadata (see itemMetadata.ts): static per-base-item facts learned from the game client. ENRICHMENT, not
-- observation truth: a separate store keyed by (game_version, base_item_id) that is never part of a snapshot's or a
-- shared observation's identity or hash. Only KNOWN values are stored (an UNKNOWN facet is the absence of a row, so it
-- can never overwrite a known one). One row per distinct value per source: two rows for one (item, facet) is a
-- CONFLICT that is exposed, never resolved by "latest wins". Like shared observations there is deliberately no
-- reference to characters or snapshots: deleting either never removes item facts.
CREATE TABLE IF NOT EXISTS item_metadata_evidence (
  game_version TEXT NOT NULL,
  base_item_id INTEGER NOT NULL CHECK (base_item_id > 0),
  facet TEXT NOT NULL CHECK (facet IN ('classID', 'subclassID', 'bindType', 'expansionID', 'isCraftingReagent')),
  source TEXT NOT NULL CHECK (source IN ('game-client')),
  value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value >= 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  client_builds TEXT NOT NULL, -- JSON array of distinct builds, sorted
  PRIMARY KEY (game_version, base_item_id, facet, source, value)
) WITHOUT ROWID;

-- Retail currencies (the Currency tab), from GearExport's STRUCTURED SavedVariables section
-- WoWSyncDB.characters[guid].sections.currencies, sent by the bridge next to the export text (never parsed from the
-- text, which is unchanged). One section row per snapshot that carried a READ currency list: no row means "never
-- captured" (UNKNOWN), never zero. carried = 1 marks a list older than the snapshot's own session (see
-- wowCurrencies.ts currencyCarryReason); reads show it as LAST_SEEN with observed_at. Every entry column is nullable:
-- a field the game did not report stays NULL, never 0. Rows are removed only with their character (deleteCharacter).
CREATE TABLE IF NOT EXISTS snapshot_currency_sections (
  snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id),
  character_id INTEGER NOT NULL REFERENCES characters(id),
  observed_at INTEGER,
  list_read INTEGER NOT NULL CHECK (list_read IN (0, 1)),
  completeness TEXT,
  format_version INTEGER,
  list_size INTEGER,
  list_filter TEXT,
  coverage TEXT,
  carried INTEGER NOT NULL DEFAULT 0 CHECK (carried IN (0, 1)),
  carried_reason TEXT,
  last_attempt_error TEXT,
  entry_count INTEGER NOT NULL,
  dropped_entries INTEGER NOT NULL DEFAULT 0,
  stored_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_currency_sections_character ON snapshot_currency_sections(character_id);

CREATE TABLE IF NOT EXISTS snapshot_currencies (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  character_id INTEGER NOT NULL REFERENCES characters(id),
  currency_id INTEGER NOT NULL CHECK (currency_id > 0),
  name TEXT,
  header TEXT,
  sub_header TEXT,
  list_order INTEGER,
  icon_file_id INTEGER,
  quantity INTEGER,
  max_quantity INTEGER,
  quantity_earned_this_week INTEGER,
  max_weekly_quantity INTEGER,
  can_earn_per_week INTEGER CHECK (can_earn_per_week IN (0, 1)),
  total_earned INTEGER,
  use_total_earned_for_max_qty INTEGER CHECK (use_total_earned_for_max_qty IN (0, 1)),
  is_account_wide INTEGER CHECK (is_account_wide IN (0, 1)),
  is_account_transferable INTEGER CHECK (is_account_transferable IN (0, 1)),
  transfer_percentage REAL,
  PRIMARY KEY (snapshot_id, currency_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_currencies_character ON snapshot_currencies(character_id, currency_id);

-- Retail equipment-envelope observations (GearExport sections.equipment, optionally with
-- specEquipmentObservation). Append-only evidence: identity is the character-scoped
-- canonical tuple, NOT the snapshot row. snapshot_id records the row the evidence arrived with.
CREATE TABLE IF NOT EXISTS snapshot_equipment_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  observed_at INTEGER NOT NULL,
  capture INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  evidence_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  UNIQUE (character_id, observed_at, capture, revision)
);

-- Explicit Demand (see demand.ts): the one new durable domain concept for Azeroth ERP Vertical Slice 1.
-- Demand is USER INTENT, not a WoW observation: persistence represents CURRENT intent (mutable status/
-- quantity/purpose), never an audit/event history, and there is deliberately no reference to characters
-- or snapshots (same reasoning as shared_observations / item_metadata_evidence). The partial unique
-- index enforces "one effective active demand per (version, demand type, commodity)" at the DB layer,
-- while still letting INACTIVE history rows coexist.
CREATE TABLE IF NOT EXISTS demands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stable_id TEXT NOT NULL UNIQUE,
  game_version TEXT NOT NULL CHECK (game_version = 'retail'),
  demand_type TEXT NOT NULL CHECK (demand_type IN ('STOCK_TARGET')),
  base_item_id INTEGER NOT NULL CHECK (base_item_id > 0),
  required_quantity INTEGER NOT NULL CHECK (required_quantity >= 0),
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')) DEFAULT 'ACTIVE',
  supersedes_stable_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_demands_active_key
  ON demands(game_version, demand_type, base_item_id) WHERE status = 'ACTIVE';

-- User-authored ERP planning state. This is intent and manual execution state, never observed game state.
-- Aggregate JSON keeps work orders, explicit resource needs, and reservations transactionally versioned.
CREATE TABLE IF NOT EXISTS erp_projects (
  stable_id TEXT PRIMARY KEY,
  game_version TEXT NOT NULL CHECK (game_version IN ('classic-era','tbc-anniversary','retail','forever')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  project_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_erp_projects_version_status ON erp_projects(game_version, updated_at DESC);
CREATE TABLE IF NOT EXISTS erp_project_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  game_version TEXT NOT NULL CHECK (game_version IN ('classic-era','tbc-anniversary','retail','forever')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  occurred_at INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE(project_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_erp_project_events_project_revision ON erp_project_events(project_id, revision DESC);
`;

/** Bump only if the backfill's ALGORITHM changes; it is deliberately not tied to the content-hash version. */
const SHARED_BACKFILL_VERSION = "1";
const SHARED_BACKFILL_KEY = "shared_storage_backfill";

interface CharacterRow {
  id: number;
  version: string;
  realm: string;
  name: string;
  identity_key: string;
  class: string | null;
  faction: string | null;
  created_at: number;
}

interface SnapshotRow {
  id: number;
  character_id: number;
  generated_at: number | null;
  imported_at: number;
  level: number | null;
  money_copper: number | null;
  played_seconds: number | null;
  level_played_seconds: number | null;
  raw_text: string;
  parsed_json: string;
}

interface ItemEvidenceRow {
  game_version: string;
  base_item_id: number;
  facet: string;
  source: string;
  value: number;
  first_seen_at: number;
  last_seen_at: number;
  client_builds: string;
}

interface DemandRow {
  id: number;
  stable_id: string;
  game_version: string;
  demand_type: string;
  base_item_id: number;
  required_quantity: number;
  purpose: string | null;
  status: string;
  supersedes_stable_id: string | null;
  created_at: number;
  updated_at: number;
}

function toStoredDemand(row: DemandRow): StoredDemand {
  if (row.game_version !== "retail") throw new Error(`Corrupt demand row ${row.stable_id}: unsupported game_version "${row.game_version}"`);
  if (row.demand_type !== "STOCK_TARGET") throw new Error(`Corrupt demand row ${row.stable_id}: unsupported demand_type "${row.demand_type}"`);
  if (row.status !== "ACTIVE" && row.status !== "INACTIVE") throw new Error(`Corrupt demand row ${row.stable_id}: unsupported status "${row.status}"`);
  return {
    stableId: row.stable_id,
    gameVersion: "retail",
    demandType: row.demand_type,
    baseItemId: row.base_item_id,
    requiredQuantity: row.required_quantity,
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    status: row.status,
    ...(row.supersedes_stable_id !== null ? { supersedesStableId: row.supersedes_stable_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SharedObservationRow {
  id: number;
  identity: string;
  owner_key: string;
  owner_json: string;
  claimed_observed_at: number;
  completeness: string;
  content_hash: string;
  hash_version: number;
  content_json: string;
}

interface SharedSourceRow {
  observation_id: number;
  snapshot_id: number;
  carrier_state: string;
  export_observed_at: number;
  source_identity_key: string;
  source_name: string;
  source_realm: string;
  snapshot_visit: number | null;
  last_visit: number | null;
  visited_npc: string | null;
  visited_zone: string | null;
  coverage_note: string | null;
  refresh_issue: string | null;
  pending: number | null;
}

function toSource(row: SharedSourceRow): SharedObservationSource {
  return {
    snapshotId: row.snapshot_id,
    carrierState: row.carrier_state as CarrierState,
    exportObservedAt: row.export_observed_at,
    sourceIdentityKey: row.source_identity_key,
    sourceName: row.source_name,
    sourceRealm: row.source_realm,
    snapshotVisit: row.snapshot_visit ?? undefined,
    lastVisit: row.last_visit ?? undefined,
    visitedNpc: row.visited_npc ?? undefined,
    visitedZone: row.visited_zone ?? undefined,
    coverageNote: row.coverage_note ?? undefined,
    refreshIssue: row.refresh_issue ?? undefined,
    pending: row.pending === 1 ? true : undefined,
  };
}

function toImportOutcome(section: RecordedSection): SharedStorageImportOutcome {
  if (section.outcome === "skipped") return { section: section.section, outcome: "skipped", reason: section.reason };
  const content = section.observation?.content;
  return {
    section: section.section,
    outcome: section.outcome === "new-observation" ? "recorded" : section.outcome === "new-source" ? "source-added" : "already-known",
    ownerKey: section.ownerKey,
    becameCurrent: section.becameCurrent,
    informative: content ? isInformativeContent(content) : undefined,
  };
}

interface CurrencySectionRow {
  snapshot_id: number;
  character_id: number;
  observed_at: number | null;
  list_read: number;
  completeness: string | null;
  format_version: number | null;
  list_size: number | null;
  list_filter: string | null;
  coverage: string | null;
  carried: number;
  carried_reason: string | null;
  last_attempt_error: string | null;
  entry_count: number;
  generated_at: number | null;
  imported_at: number;
}

interface CurrencyRow {
  currency_id: number;
  name: string | null;
  header: string | null;
  sub_header: string | null;
  list_order: number | null;
  icon_file_id: number | null;
  quantity: number | null;
  max_quantity: number | null;
  quantity_earned_this_week: number | null;
  max_weekly_quantity: number | null;
  can_earn_per_week: number | null;
  total_earned: number | null;
  use_total_earned_for_max_qty: number | null;
  is_account_wide: number | null;
  is_account_transferable: number | null;
  transfer_percentage: number | null;
}

const flag = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
const unflag = (v: number | null): boolean | null => (v === null ? null : v !== 0);

function toCurrencySectionMeta(row: CurrencySectionRow): StoredCurrencySectionMeta {
  return {
    snapshotId: row.snapshot_id,
    snapshotObservedAt: snapshotObservedAt(row.generated_at, row.imported_at),
    observedAt: row.observed_at,
    listRead: row.list_read === 1,
    completeness: row.completeness,
    formatVersion: row.format_version,
    listSize: row.list_size,
    listFilter: row.list_filter,
    coverage: row.coverage,
    carried: row.carried === 1,
    carriedReason: (row.carried_reason as CurrencyCarryReason | null) ?? null,
    lastAttemptError: row.last_attempt_error,
    entryCount: row.entry_count,
  };
}

function toCurrencyValues(row: CurrencyRow): CurrencyValues {
  return {
    currencyID: row.currency_id,
    name: row.name,
    header: row.header,
    subHeader: row.sub_header,
    listOrder: row.list_order,
    iconFileID: row.icon_file_id,
    quantity: row.quantity,
    maxQuantity: row.max_quantity,
    quantityEarnedThisWeek: row.quantity_earned_this_week,
    maxWeeklyQuantity: row.max_weekly_quantity,
    canEarnPerWeek: unflag(row.can_earn_per_week),
    totalEarned: row.total_earned,
    useTotalEarnedForMaxQty: unflag(row.use_total_earned_for_max_qty),
    isAccountWide: unflag(row.is_account_wide),
    isAccountTransferable: unflag(row.is_account_transferable),
    transferPercentage: row.transfer_percentage,
  };
}

function one<T>(stmt: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return stmt.get(...params) as unknown as T | undefined;
}
function many<T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] {
  return stmt.all(...params) as unknown as T[];
}

function toStoredSnapshot(row: SnapshotRow): StoredSnapshot {
  return {
    id: row.id,
    characterId: row.character_id,
    generatedAt: row.generated_at ?? undefined,
    importedAt: row.imported_at,
    parsed: JSON.parse(row.parsed_json) as ParsedSnapshot,
  };
}

export class SnapshotReadStoreOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotReadStoreOpenError";
  }
}

interface SqliteStoreOpenOptions {
  /** Internal support for the narrow SqliteSnapshotReadStore wrapper only. */
  readOnly?: boolean;
}

const READ_ONLY_REQUIRED_TABLES = [
  "characters",
  "snapshots",
  "store_meta",
  "shared_observations",
  "shared_observation_sources",
  "shared_owner_clears",
  "snapshot_currency_sections",
  "snapshot_currencies",
  "snapshot_equipment_observations",
  "item_metadata_evidence",
  "demands",
  "erp_projects",
  "erp_project_events",
] as const;

export class SqliteSnapshotStore implements SnapshotStore {
  private db: DatabaseSync;
  private stmts: Record<string, StatementSync>;
  private readonly readOnly: boolean;

  constructor(path: string, options: SqliteStoreOpenOptions = {}) {
    this.readOnly = options.readOnly === true;
    if (this.readOnly && (path === ":memory:" || !existsSync(path))) {
      throw new SnapshotReadStoreOpenError(`Cannot open WoWSync database read-only: the database file does not exist (${path}).`);
    }
    try {
      this.db = this.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    } catch (error) {
      if (this.readOnly) throw new SnapshotReadStoreOpenError(`Cannot open WoWSync database read-only: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (!this.readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA);
    }
    try {
      this.stmts = {
      findCharacterByKey: this.db.prepare("SELECT * FROM characters WHERE identity_key = ?"),
      insertCharacter: this.db.prepare(
        "INSERT INTO characters (version, realm, name, identity_key, class, faction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      updateCharacterAttrs: this.db.prepare("UPDATE characters SET class = ?, faction = ? WHERE id = ?"),
      insertSnapshot: this.db.prepare(
        `INSERT INTO snapshots
          (character_id, generated_at, imported_at, level, money_copper, played_seconds, level_played_seconds, raw_text, parsed_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      // "Latest"/"previous" follow OBSERVATION time (see chronology.ts), never import time.
      latestSnapshotForCharacter: this.db.prepare(
        `SELECT * FROM snapshots WHERE character_id = ? ORDER BY ${SNAPSHOTS_NEWEST_FIRST_SQL} LIMIT 1`,
      ),
      snapshotsWithSameGeneratedAt: this.db.prepare(
        "SELECT * FROM snapshots WHERE character_id = ? AND generated_at IS ? ORDER BY id",
      ),
      snapshotCountForCharacter: this.db.prepare("SELECT COUNT(*) as n FROM snapshots WHERE character_id = ?"),
      charactersByVersion: this.db.prepare("SELECT * FROM characters WHERE version = ? ORDER BY name"),
      allCharacters: this.db.prepare("SELECT * FROM characters ORDER BY version, name"),
      snapshotsForCharacter: this.db.prepare(
        `SELECT * FROM snapshots WHERE character_id = ? ORDER BY ${SNAPSHOTS_NEWEST_FIRST_SQL}`,
      ),
      equipmentObservationsForCharacter: this.db.prepare(
        "SELECT snapshot_id, observed_at, capture, revision, completeness, evidence_json FROM snapshot_equipment_observations WHERE character_id = ? ORDER BY observed_at DESC, capture DESC, revision DESC",
      ),
      snapshotById: this.db.prepare("SELECT * FROM snapshots WHERE id = ?"),
      updateParsedSnapshot: this.db.prepare("UPDATE snapshots SET parsed_json = ? WHERE id = ?"),
      deleteSnapshotsForCharacter: this.db.prepare("DELETE FROM snapshots WHERE character_id = ?"),
      deleteCharacterById: this.db.prepare("DELETE FROM characters WHERE id = ?"),
      getMeta: this.db.prepare("SELECT value FROM store_meta WHERE key = ?"),
      setMeta: this.db.prepare(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),
      insertSharedObservation: this.db.prepare(
        `INSERT OR IGNORE INTO shared_observations
          (identity, owner_key, owner_kind, owner_json, claimed_observed_at, completeness, content_hash, hash_version, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      sharedObservationId: this.db.prepare("SELECT id FROM shared_observations WHERE identity = ?"),
      insertSharedSource: this.db.prepare(
        `INSERT OR IGNORE INTO shared_observation_sources
          (observation_id, snapshot_id, carrier_state, export_observed_at, source_identity_key, source_name, source_realm,
           snapshot_visit, last_visit, visited_npc, visited_zone, coverage_note, refresh_issue, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      countSharedObservationsForOwner: this.db.prepare("SELECT COUNT(*) AS n FROM shared_observations WHERE owner_key = ?"),
      deleteSharedSourcesForOwner: this.db.prepare(
        "DELETE FROM shared_observation_sources WHERE observation_id IN (SELECT id FROM shared_observations WHERE owner_key = ?)",
      ),
      deleteSharedObservationsForOwner: this.db.prepare("DELETE FROM shared_observations WHERE owner_key = ?"),
      // The highest snapshot id EVER allocated (sqlite_sequence survives deletions), or 0 if none.
      highestSnapshotId: this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'snapshots'), 0) AS n"),
      upsertOwnerClear: this.db.prepare(
        `INSERT INTO shared_owner_clears (owner_key, cleared_through_snapshot_id, cleared_at) VALUES (?, ?, ?)
         ON CONFLICT(owner_key) DO UPDATE SET
           cleared_through_snapshot_id = MAX(cleared_through_snapshot_id, excluded.cleared_through_snapshot_id),
           cleared_at = excluded.cleared_at`,
      ),
      allOwnerClears: this.db.prepare("SELECT owner_key, cleared_through_snapshot_id FROM shared_owner_clears"),
      itemEvidenceForKey: this.db.prepare(
        "SELECT * FROM item_metadata_evidence WHERE game_version = ? AND base_item_id = ? AND facet = ? AND source = ? AND value = ?",
      ),
      insertItemEvidence: this.db.prepare(
        `INSERT INTO item_metadata_evidence (game_version, base_item_id, facet, source, value, first_seen_at, last_seen_at, client_builds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateItemEvidence: this.db.prepare(
        `UPDATE item_metadata_evidence SET first_seen_at = ?, last_seen_at = ?, client_builds = ?
          WHERE game_version = ? AND base_item_id = ? AND facet = ? AND source = ? AND value = ?`,
      ),
      itemEvidenceForVersion: this.db.prepare(
        "SELECT * FROM item_metadata_evidence WHERE game_version = ? ORDER BY base_item_id, facet, source, value",
      ),
      allSharedObservations: this.db.prepare("SELECT * FROM shared_observations ORDER BY id"),
      allSharedSources: this.db.prepare("SELECT * FROM shared_observation_sources ORDER BY observation_id, snapshot_id"),
      // A cheap pre-filter only: a false positive is re-checked by parsing (the sections are optional JSON keys).
      snapshotsWithSharedSections: this.db.prepare(
        `SELECT s.*, c.identity_key AS c_identity_key, c.name AS c_name, c.realm AS c_realm
           FROM snapshots s JOIN characters c ON c.id = s.character_id
          WHERE s.parsed_json LIKE '%"accountBank"%' OR s.parsed_json LIKE '%"guildBank"%'
          ORDER BY s.id`,
      ),
      currencySectionForSnapshot: this.db.prepare("SELECT * FROM snapshot_currency_sections WHERE snapshot_id = ?"),
      currencySectionsForCharacter: this.db.prepare(
        `SELECT sec.*, s.generated_at AS generated_at, s.imported_at AS imported_at
           FROM snapshot_currency_sections sec JOIN snapshots s ON s.id = sec.snapshot_id
          WHERE sec.character_id = ?`,
      ),
      insertCurrencySection: this.db.prepare(
        `INSERT INTO snapshot_currency_sections
          (snapshot_id, character_id, observed_at, list_read, completeness, format_version, list_size, list_filter, coverage,
           carried, carried_reason, last_attempt_error, entry_count, dropped_entries, stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertCurrency: this.db.prepare(
        `INSERT INTO snapshot_currencies
          (snapshot_id, character_id, currency_id, name, header, sub_header, list_order, icon_file_id, quantity, max_quantity,
           quantity_earned_this_week, max_weekly_quantity, can_earn_per_week, total_earned, use_total_earned_for_max_qty,
           is_account_wide, is_account_transferable, transfer_percentage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      currenciesForSnapshot: this.db.prepare("SELECT * FROM snapshot_currencies WHERE snapshot_id = ? ORDER BY list_order, currency_id"),
      deleteCurrenciesForCharacter: this.db.prepare("DELETE FROM snapshot_currencies WHERE character_id = ?"),
      deleteCurrencySectionsForCharacter: this.db.prepare("DELETE FROM snapshot_currency_sections WHERE character_id = ?"),
      equipmentObservationForTuple: this.db.prepare(
        "SELECT completeness, evidence_json FROM snapshot_equipment_observations WHERE character_id = ? AND observed_at = ? AND capture = ? AND revision = ?",
      ),
      insertEquipmentObservation: this.db.prepare(
        "INSERT INTO snapshot_equipment_observations (character_id, snapshot_id, observed_at, capture, revision, completeness, evidence_json, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      deleteEquipmentObservationsForCharacter: this.db.prepare("DELETE FROM snapshot_equipment_observations WHERE character_id = ?"),
      insertDemand: this.db.prepare(
        `INSERT INTO demands (stable_id, game_version, demand_type, base_item_id, required_quantity, purpose, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      ),
      demandByStableId: this.db.prepare("SELECT * FROM demands WHERE stable_id = ?"),
      activeDemandByKey: this.db.prepare("SELECT * FROM demands WHERE game_version = ? AND demand_type = ? AND base_item_id = ? AND status = 'ACTIVE'"),
      demandsForVersion: this.db.prepare("SELECT * FROM demands WHERE game_version = ? ORDER BY updated_at DESC, id DESC"),
      updateDemandFields: this.db.prepare("UPDATE demands SET required_quantity = ?, purpose = ?, updated_at = ? WHERE stable_id = ?"),
      deactivateDemandRow: this.db.prepare("UPDATE demands SET status = 'INACTIVE', updated_at = ? WHERE stable_id = ?"),
    };
      if (this.readOnly) {
        this.assertReadOnlySchema();
      } else {
        // One-time, idempotent: journals shared storage already present in stored snapshots.
        if (one<{ value: string }>(this.stmts.getMeta, SHARED_BACKFILL_KEY)?.value !== SHARED_BACKFILL_VERSION) this.backfillSharedStorage();
      }
    } catch (error) {
      this.db.close();
      if (this.readOnly) {
        if (error instanceof SnapshotReadStoreOpenError) throw error;
        throw new SnapshotReadStoreOpenError(`Cannot open WoWSync database read-only: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  private assertReadOnlySchema(): void {
    const rows = many<{ name: string }>(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'"));
    const tables = new Set(rows.map((row) => row.name));
    const missing = READ_ONLY_REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) {
      throw new SnapshotReadStoreOpenError(`WoWSync database schema is missing required table(s): ${missing.join(", ")}. Open it through the normal Dashboard/import path to create or migrate it.`);
    }
  }

  /**
   * Runs `fn` in one transaction (all or nothing). Re-entrant: inside an
   * already-open transaction it just runs `fn`, since SQLite does not nest
   * BEGINs.
   */
  private inTransaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A ROLLBACK that itself fails must not replace the error that caused it.
      }
      throw err;
    }
  }

  importSnapshot(raw: string, extras: ImportExtras = {}): ImportResult {
    // Parse first: a malformed export throws before anything is written.
    const parsed = parseWowSyncExport(raw);
    const version = detectVersion(parsed.character);
    const normalizedCharacterState = normalizeCharacterStateSidecar(extras.characterState, version);
    if (normalizedCharacterState) parsed.characterState = normalizedCharacterState;
    const normalizedForeverObservation = normalizeForeverStructuredObservation(extras.foreverGearObservation, version, parsed.character.name, parsed.character.realm, parsed.generatedAt);
    if (normalizedForeverObservation) parsed.foreverGearObservation = normalizedForeverObservation;
    const identity = characterIdentity(version, parsed.character);
    const now = Math.floor(Date.now() / 1000);

    return this.inTransaction((): ImportResult => {
      let characterRow = one<CharacterRow>(this.stmts.findCharacterByKey, identity.key);
      const isNewCharacter = !characterRow;

      if (characterRow) {
        // Idempotency: the same export (same character, same Generated value,
        // same text modulo copy/paste whitespace) is never stored twice. Only
        // content equality counts - two DIFFERENT exports can legitimately
        // share a Generated timestamp (one-second resolution) and both are
        // real observations. A duplicate changes nothing at all.
        const wanted = normalizeExportText(raw);
        const existing = many<SnapshotRow>(this.stmts.snapshotsWithSameGeneratedAt, characterRow.id, parsed.generatedAt ?? null).find(
          (row) => normalizeExportText(row.raw_text) === wanted,
        );
        if (existing) {
          const newest = one<SnapshotRow>(this.stmts.latestSnapshotForCharacter, characterRow.id);
          // The text changes nothing. The only thing a duplicate may add is a currencies section the snapshot does not
          // have yet (the same export sent before the bridge carried currencies): additive and idempotent.
          const currencies =
            extras.currencies === undefined ? undefined : this.recordCurrencies(characterRow.id, existing.id, version, extras.currencies, now, true);
          let characterStateOutcome: ImportResult["characterState"];
          if (extras.characterState !== undefined) {
            const existingParsed = toStoredSnapshot(existing).parsed;
            const merged = mergeCharacterState(existingParsed.characterState, normalizedCharacterState);
            if (merged) {
              existingParsed.characterState = merged;
              existing.parsed_json = JSON.stringify(existingParsed);
              this.stmts.updateParsedSnapshot.run(existing.parsed_json, existing.id);
            }
            characterStateOutcome = normalizedCharacterState ? "recorded" : "invalid-or-unsupported";
          }
          const equipmentObservation =
            extras.equipmentObservation === undefined ? undefined : this.recordEquipmentObservation(characterRow.id, existing.id, version, extras.equipmentObservation, now);
          let foreverGearOutcome: ImportResult["foreverGearObservation"];
          if (extras.foreverGearObservation !== undefined) {
            const existingParsed = toStoredSnapshot(existing).parsed;
            if (!normalizedForeverObservation) foreverGearOutcome = "invalid-or-unsupported";
            else {
              const merged = mergeForeverStructuredObservation(existingParsed.foreverGearObservation, normalizedForeverObservation);
              existingParsed.foreverGearObservation = merged.value;
              existing.parsed_json = JSON.stringify(existingParsed);
              this.stmts.updateParsedSnapshot.run(existing.parsed_json, existing.id);
              foreverGearOutcome = merged.outcome;
            }
          }
          const duplicateSnapshot = toStoredSnapshot(existing);
          return {
            character: this.summarize(characterRow.id)!,
            snapshot: duplicateSnapshot,
            previousSnapshot: undefined,
            diff: undefined,
            isFirstSnapshot: false,
            isDuplicate: true,
            isLatest: newest?.id === existing.id,
            sharedStorage: [],
            ...(currencies ? { currencies } : {}),
            ...(characterStateOutcome ? { characterState: characterStateOutcome } : {}),
            ...(equipmentObservation ? { equipmentObservation } : {}),
            ...(foreverGearOutcome ? { foreverGearObservation: foreverGearOutcome } : {}),
          };
        }
      } else {
        this.stmts.insertCharacter.run(
          version,
          identity.realm,
          identity.name,
          identity.key,
          parsed.character.class ?? null,
          parsed.character.faction ?? null,
          now,
        );
        characterRow = one<CharacterRow>(this.stmts.findCharacterByKey, identity.key)!;
      }

      const insertResult = this.stmts.insertSnapshot.run(
        characterRow.id,
        parsed.generatedAt ?? null,
        now,
        parsed.character.level ?? null,
        parsed.character.moneyCopper ?? null,
        parsed.character.playedSeconds ?? null,
        parsed.character.levelPlayedSeconds ?? null,
        raw,
        JSON.stringify(parsed),
      );
      const newId = Number(insertResult.lastInsertRowid);

      // Where did the new snapshot land in chronological (observation) order?
      // Newest first: [0] is current state; the NEXT element is its predecessor.
      const rows = many<SnapshotRow>(this.stmts.snapshotsForCharacter, characterRow.id);
      const index = rows.findIndex((row) => row.id === newId);
      const isLatest = index === 0;
      const predecessorRow = rows[index + 1];
      if (isLatest && predecessorRow) {
        const predecessor = toStoredSnapshot(predecessorRow).parsed.characterState;
        const merged = mergeCharacterState(predecessor, parsed.characterState);
        if (merged) {
          parsed.characterState = merged;
          this.stmts.updateParsedSnapshot.run(JSON.stringify(parsed), newId);
          rows[index].parsed_json = JSON.stringify(parsed);
        }
      }
      const snapshot = toStoredSnapshot(rows[index]);
      const previousSnapshot = predecessorRow ? toStoredSnapshot(predecessorRow) : undefined;
      const diff = previousSnapshot ? diffSnapshots(previousSnapshot.parsed, parsed) : undefined;

      // Class/faction describe the character's CURRENT state, so only the
      // newest observation may change them - an older export imported later
      // must not overwrite what a newer one said.
      if (!isNewCharacter && isLatest && (parsed.character.class || parsed.character.faction)) {
        this.stmts.updateCharacterAttrs.run(
          parsed.character.class ?? characterRow.class,
          parsed.character.faction ?? characterRow.faction,
          characterRow.id,
        );
      }

      // Shared storage carried by this export joins the journal in THIS transaction: either the
      // snapshot and its admitted observations are stored together, or neither is.
      // No owner is ever skipped here: a cleared owner's cutoff only limits backfill, never new evidence.
      const { outcomes: sharedStorage } = this.recordSharedStorage(
        parsed,
        {
          snapshotId: newId,
          sourceIdentityKey: identity.key,
          sourceName: identity.name,
          sourceRealm: identity.realm,
          exportObservedAt: snapshotObservedAt(rows[index].generated_at, rows[index].imported_at),
        },
        now,
      );

      // Item metadata carried by this export joins its own store in the same transaction. It only ever adds
      // (or widens the provenance of) KNOWN facts; it cannot alter this snapshot, any observation, or any hash.
      if (version !== UNKNOWN_VERSION && parsed.itemMetadata) {
        this.recordItemMetadata(
          version,
          parsed,
          snapshotObservedAt(rows[index].generated_at, rows[index].imported_at),
        );
      }

      // The structured currencies section (if the bridge sent one) joins this snapshot in the same transaction.
      const currencies =
        extras.currencies === undefined ? undefined : this.recordCurrencies(characterRow.id, newId, version, extras.currencies, now, false);

      // The structured equipment observation (if the bridge sent one) joins this snapshot in the same transaction.
      const equipmentObservation =
        extras.equipmentObservation === undefined ? undefined : this.recordEquipmentObservation(characterRow.id, newId, version, extras.equipmentObservation, now);

      return {
        character: this.summarize(characterRow.id)!,
        snapshot,
        previousSnapshot,
        diff,
        isFirstSnapshot: rows.length === 1,
        isDuplicate: false,
        isLatest,
        sharedStorage,
        ...(currencies ? { currencies } : {}),
        ...(equipmentObservation ? { equipmentObservation } : {}),
        ...(extras.foreverGearObservation !== undefined ? { foreverGearObservation: normalizedForeverObservation ? "recorded" : "invalid-or-unsupported" } : {}),
        ...(extras.characterState !== undefined ? { characterState: normalizedCharacterState ? "recorded" : "invalid-or-unsupported" } : {}),
      };
    });
  }

  // --- Currencies (structured SavedVariables section) ------------------------------------------------

  /** Attaches a validated currencies section to one snapshot. Never alters the snapshot; a bad section is a skip, not an error. */
  private recordCurrencies(characterId: number, snapshotId: number, version: VersionOrUnknown, input: unknown, now: number, duplicate: boolean): CurrencyImportOutcome {
    if (version !== "retail") return { outcome: "skipped", reason: "unsupported-version", snapshotId };
    const normalized = normalizeCurrencySection(input);
    if (!normalized.ok) return { outcome: "skipped", reason: normalized.reason, snapshotId };
    const stored = one<CurrencySectionRow>(this.stmts.currencySectionForSnapshot, snapshotId);
    if (stored) {
      return {
        outcome: "already-stored",
        snapshotId,
        rows: stored.entry_count,
        observedAt: stored.observed_at,
        carried: stored.carried === 1,
        ...(stored.carried_reason ? { carriedReason: stored.carried_reason as CurrencyCarryReason } : {}),
      };
    }
    const section = normalized.section;
    // Chronological position of the owning snapshot: its own observation time and its predecessor's.
    const rows = many<SnapshotRow>(this.stmts.snapshotsForCharacter, characterId);
    const index = rows.findIndex((row) => row.id === snapshotId);
    const own = rows[index];
    const predecessor = rows[index + 1];
    const carriedReason = currencyCarryReason(
      section.observedAt,
      snapshotObservedAt(own.generated_at, own.imported_at),
      predecessor ? snapshotObservedAt(predecessor.generated_at, predecessor.imported_at) : undefined,
      section.lastAttemptError,
    );
    this.stmts.insertCurrencySection.run(
      snapshotId,
      characterId,
      section.observedAt,
      section.listRead ? 1 : 0,
      section.completeness,
      section.formatVersion,
      section.listSize,
      section.listFilter,
      section.coverage,
      carriedReason ? 1 : 0,
      carriedReason ?? null,
      section.lastAttemptError,
      section.entries.length,
      section.droppedEntries,
      now,
    );
    for (const e of section.entries) {
      this.stmts.insertCurrency.run(
        snapshotId,
        characterId,
        e.currencyID,
        e.name,
        e.header,
        e.subHeader,
        e.listOrder,
        e.iconFileID,
        e.quantity,
        e.maxQuantity,
        e.quantityEarnedThisWeek,
        e.maxWeeklyQuantity,
        flag(e.canEarnPerWeek),
        e.totalEarned,
        flag(e.useTotalEarnedForMaxQty),
        flag(e.isAccountWide),
        flag(e.isAccountTransferable),
        e.transferPercentage,
      );
    }
    return {
      outcome: duplicate ? "attached" : "stored",
      snapshotId,
      rows: section.entries.length,
      droppedEntries: section.droppedEntries,
      observedAt: section.observedAt,
      carried: carriedReason !== undefined,
      ...(carriedReason ? { carriedReason } : {}),
    };
  }

  /** Attaches a validated equipment observation to one snapshot. Never alters the snapshot; a bad observation is a skip, not an error. */
  private recordEquipmentObservation(
    characterId: number,
    snapshotId: number,
    version: VersionOrUnknown,
    input: unknown,
    now: number
  ): ImportResult["equipmentObservation"] {
    // Step 1: Normalize and validate envelope structure
    const normalized = normalizeEquipmentObservation(input, version);
    if (!normalized.ok) {
      return normalized.outcome as EquipmentNormalizationOutcome;
    }

    const observation = normalized.value;
    const projection = (input as Record<string, unknown> | undefined)?.projection;

    // Step 2: Evaluate policy A-E
    const policyResult = evaluateEquipmentPolicy(observation, projection);
    if (!policyResult.ok) {
      return policyResult.outcome;
    }

    // Step 3: Check for existing observation with the same tuple
    const existing = one<{ completeness: string; evidence_json: string }>(
      this.stmts.equipmentObservationForTuple,
      characterId,
      observation.observedAt,
      observation.capture,
      observation.revision
    );

    // Step 4: Build evidence JSON (canonical, key-sorted)
    const evidenceValue = {
      slots: observation.slots,
      ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
      ...(observation.source !== undefined ? { source: observation.source } : {}),
      ...(observation.changedAt !== undefined ? { changedAt: observation.changedAt } : {}),
      ...(observation.specEquipmentObservation !== undefined ? { specEquipmentObservation: observation.specEquipmentObservation } : {}),
    };
    const evidenceJson = canonicalJson(evidenceValue);

    if (existing) {
      // Check if evidence is identical
      if (existing.completeness === observation.completeness && existing.evidence_json === evidenceJson) {
        return "already-recorded";
      }
      // Different evidence for the same tuple: conflict
      return "conflict";
    }

    // Step 5: Insert new row
    this.stmts.insertEquipmentObservation.run(
      characterId,
      snapshotId,
      observation.observedAt,
      observation.capture,
      observation.revision,
      observation.completeness,
      evidenceJson,
      now
    );

    return "recorded";
  }

  private resolveCurrencies(row: CharacterRow): CharacterCurrencies {
    const latest = one<SnapshotRow>(this.stmts.latestSnapshotForCharacter, row.id);
    const metas = many<CurrencySectionRow>(this.stmts.currencySectionsForCharacter, row.id).map(toCurrencySectionMeta);
    const pick = pickCurrencySection(latest?.id, metas);
    const entries = pick ? many<CurrencyRow>(this.stmts.currenciesForSnapshot, pick.section.snapshotId).map(toCurrencyValues) : [];
    return characterCurrenciesView(
      { identityKey: row.identity_key, name: row.name, realm: row.realm, version: row.version as VersionOrUnknown },
      pick,
      entries,
    );
  }

  getCharacterCurrencies(identityKey: string): CharacterCurrencies | undefined {
    const row = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    return row ? this.resolveCurrencies(row) : undefined;
  }

  getCharacterCurrenciesForSnapshot(identityKey: string, snapshotId: number): CharacterCurrencies | undefined {
    const character = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    if (!character) return undefined;
    const snapshot = one<SnapshotRow>(this.stmts.snapshotById, snapshotId);
    if (!snapshot || snapshot.character_id !== character.id) return undefined;
    const section = one<CurrencySectionRow>(this.stmts.currencySectionForSnapshot, snapshotId);
    const pick = section
      ? pickCurrencySection(snapshotId, [{ ...section, generated_at: snapshot.generated_at, imported_at: snapshot.imported_at }].map(toCurrencySectionMeta))
      : undefined;
    const entries = pick ? many<CurrencyRow>(this.stmts.currenciesForSnapshot, snapshotId).map(toCurrencyValues) : [];
    return characterCurrenciesView(
      { identityKey: character.identity_key, name: character.name, realm: character.realm, version: character.version as VersionOrUnknown },
      pick,
      entries,
    );
  }

  listVersionCurrencies(version: VersionOrUnknown): AccountCurrencies {
    const rows = many<CharacterRow>(this.stmts.charactersByVersion, version);
    return buildAccountCurrencies(version, rows.map((row) => this.resolveCurrencies(row)));
  }

  // --- Item metadata ----------------------------------------------------------------------------------
  //
  // Persistence only; every rule (what a value means, conflicts, expansion labels) is in itemMetadata.ts.

  /**
   * Folds the KNOWN facets of one export's `[ITEM METADATA]` into the evidence store. Idempotent and
   * order-independent (see mergeEvidence): replaying an export, or importing exports in any order, produces the
   * same rows. A client that is not a routable game version records nothing (no version, no scope to key by).
   */
  private recordItemMetadata(version: WowVersion, parsed: ParsedSnapshot, seenAt: number): void {
    const source: ItemMetadataSource = "game-client";
    for (const fact of knownFacets(parsed.itemMetadata?.rows ?? [])) {
      const key = [version, fact.baseItemId, fact.facet, source, fact.value] as const;
      const existing = one<ItemEvidenceRow>(this.stmts.itemEvidenceForKey, ...key);
      const merged = mergeEvidence(
        existing
          ? { firstSeenAt: existing.first_seen_at, lastSeenAt: existing.last_seen_at, clientBuilds: JSON.parse(existing.client_builds) as string[] }
          : undefined,
        seenAt,
        parsed.character.clientBuild,
      );
      if (!existing) {
        this.stmts.insertItemEvidence.run(...key, merged.firstSeenAt, merged.lastSeenAt, JSON.stringify(merged.clientBuilds));
      } else {
        this.stmts.updateItemEvidence.run(merged.firstSeenAt, merged.lastSeenAt, JSON.stringify(merged.clientBuilds), ...key);
      }
    }
  }

  /** The resolved item metadata for one game version: one view per item that has any evidence, ordered by item id. Empty for an unrouted version. */
  listItemMetadata(version: VersionOrUnknown): ItemMetadataView[] {
    if (version === UNKNOWN_VERSION) return [];
    return buildItemMetadataViews(version, this.loadItemEvidence(version));
  }

  getItemMetadata(version: VersionOrUnknown, baseItemIds: readonly number[]): ItemMetadataView[] {
    if (version === UNKNOWN_VERSION || baseItemIds.length === 0) return [];
    const wanted = [...new Set(baseItemIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (wanted.length > 100) throw new RangeError("At most 100 item IDs may be resolved at once");
    if (wanted.length === 0) return [];
    const rows = many<ItemEvidenceRow>(this.db.prepare(
      `SELECT * FROM item_metadata_evidence WHERE game_version = ? AND base_item_id IN (${wanted.map(() => "?").join(",")}) ORDER BY base_item_id, facet, source, value`,
    ), version, ...wanted);
    const evidence: ItemFacetEvidence[] = rows.map((row) => {
      if (!ITEM_FACETS.includes(row.facet as ItemFacetName) || !ITEM_METADATA_SOURCES.includes(row.source as ItemMetadataSource)) {
        throw new Error(`Corrupt item metadata row for item ${row.base_item_id}: unknown facet or source`);
      }
      return { gameVersion: version as WowVersion, baseItemId: row.base_item_id, facet: row.facet as ItemFacetName, source: row.source as ItemMetadataSource, value: row.value, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, clientBuilds: JSON.parse(row.client_builds) as string[] };
    });
    return buildItemMetadataViews(version, evidence);
  }

  /** The raw stored evidence for one game version (provenance included), ordered deterministically. */
  loadItemEvidence(version: WowVersion): ItemFacetEvidence[] {
    return many<ItemEvidenceRow>(this.stmts.itemEvidenceForVersion, version).map((row) => {
      if (!ITEM_FACETS.includes(row.facet as ItemFacetName) || !ITEM_METADATA_SOURCES.includes(row.source as ItemMetadataSource)) {
        throw new Error(`Corrupt item metadata row for item ${row.base_item_id}: unknown facet or source`);
      }
      return {
        gameVersion: version,
        baseItemId: row.base_item_id,
        facet: row.facet as ItemFacetName,
        source: row.source as ItemMetadataSource,
        value: row.value,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        clientBuilds: JSON.parse(row.client_builds) as string[],
      };
    });
  }

  // --- Shared-storage journal ------------------------------------------------------------------------
  //
  // Persistence only. Every rule (admission, identity, effective time, selection) lives in
  // sharedStorage.ts; this class loads rows into that model and writes back exactly what it decided.
  // Deleting a character or a snapshot never touches these tables.

  /** Loads the journal (or only the given owners') into the pure domain model. */
  private loadSharedJournalFor(ownerKeys?: readonly string[]): SharedJournal {
    if (ownerKeys?.length === 0) return { entries: new Map() };
    const marks = ownerKeys ? ownerKeys.map(() => "?").join(", ") : "";
    const observationRows = ownerKeys
      ? many<SharedObservationRow>(this.db.prepare(`SELECT * FROM shared_observations WHERE owner_key IN (${marks}) ORDER BY id`), ...ownerKeys)
      : many<SharedObservationRow>(this.stmts.allSharedObservations);
    const sourceRows = ownerKeys
      ? many<SharedSourceRow>(
          this.db.prepare(
            `SELECT s.* FROM shared_observation_sources s JOIN shared_observations o ON o.id = s.observation_id
              WHERE o.owner_key IN (${marks}) ORDER BY s.observation_id, s.snapshot_id`,
          ),
          ...ownerKeys,
        )
      : many<SharedSourceRow>(this.stmts.allSharedSources);

    const entries = new Map<string, JournalEntry>();
    const sourcesByObservation = new Map<number, Map<number, SharedObservationSource>>();
    // A damaged row is never skipped: every row is checked, then ONE error names every damaged owner
    // (from each row's own owner_key, so it works even when that row's owner JSON is the damaged part).
    const damaged = new Map<string, string>();
    for (const row of observationRows) {
      try {
        const observation = restoreSharedObservation({
          identity: row.identity,
          ownerKey: row.owner_key,
          ownerJson: row.owner_json,
          claimedObservedAt: row.claimed_observed_at,
          completeness: row.completeness,
          contentHash: row.content_hash,
          hashVersion: row.hash_version,
          contentJson: row.content_json,
        });
        const sources = new Map<number, SharedObservationSource>();
        sourcesByObservation.set(row.id, sources);
        entries.set(observation.identity, { observation, sources });
      } catch (err) {
        if (!(err instanceof SharedStorageIntegrityError)) throw err;
        if (!damaged.has(row.owner_key)) damaged.set(row.owner_key, err.detail);
      }
    }
    if (damaged.size > 0) throw new SharedStorageIntegrityError([...damaged.values()][0], [...damaged.keys()].sort());
    for (const row of sourceRows) sourcesByObservation.get(row.observation_id)?.set(row.snapshot_id, toSource(row));
    return { entries };
  }

  loadSharedJournal(): SharedJournal {
    return this.loadSharedJournalFor();
  }

  projectSharedStorage(): SharedStorageProjection {
    return projectJournal(this.loadSharedJournal());
  }

  /**
   * Admits one export's shared sections. The domain decides everything (admission, identity,
   * duplicates); this writes back only what it reports as new. Must run inside a transaction.
   */
  private recordSharedStorage(
    parsed: ParsedSnapshot,
    carrier: CarrierExport,
    now: number,
    /** Backfill only: owners whose admission from this (already stored) snapshot must not be written. */
    skipOwner?: (ownerKey: string) => boolean,
  ): { outcomes: SharedStorageImportOutcome[]; suppressed: number } {
    if (!parsed.accountBank && !parsed.guildBank) return { outcomes: [], suppressed: 0 };
    let suppressed = 0;
    const owners = admitExport(parsed, carrier).flatMap((a) => (a.admitted ? [a.observation.ownerKey] : []));
    const { sections } = recordExport(this.loadSharedJournalFor(owners), parsed, carrier);
    const written: RecordedSection[] = [];
    for (const section of sections) {
      const { observation, source, outcome } = section;
      if (observation && skipOwner?.(observation.ownerKey)) {
        suppressed++;
        continue;
      }
      written.push(section);
      if (!observation || !source || outcome === "already-known" || outcome === "skipped") continue;
      if (outcome === "new-observation") {
        const stored = serializeSharedObservation(observation);
        this.stmts.insertSharedObservation.run(
          stored.identity,
          stored.ownerKey,
          observation.owner.kind,
          stored.ownerJson,
          stored.claimedObservedAt,
          stored.completeness,
          stored.contentHash,
          stored.hashVersion,
          stored.contentJson,
          now,
        );
      }
      const observationId = one<{ id: number }>(this.stmts.sharedObservationId, observation.identity)!.id;
      this.stmts.insertSharedSource.run(
        observationId,
        source.snapshotId,
        source.carrierState,
        source.exportObservedAt,
        source.sourceIdentityKey,
        source.sourceName,
        source.sourceRealm,
        source.snapshotVisit ?? null,
        source.lastVisit ?? null,
        source.visitedNpc ?? null,
        source.visitedZone ?? null,
        source.coverageNote ?? null,
        source.refreshIssue ?? null,
        source.pending ? 1 : null,
      );
    }
    return { outcomes: written.map(toImportOutcome), suppressed };
  }

  deleteSharedStorageOwner(owner: SharedStorageOwner): DeleteSharedStorageOwnerResult {
    // Validate before touching anything: a padded or empty club id would otherwise silently match nothing.
    if (owner.kind === "guild" && (typeof owner.guildClubId !== "string" || owner.guildClubId.length === 0 || owner.guildClubId !== owner.guildClubId.trim())) {
      throw new TypeError("A guild owner needs a non-empty GuildClubID without surrounding whitespace.");
    }
    let key: string;
    try {
      key = ownerKey(owner);
    } catch {
      throw new TypeError("Unsupported shared-storage owner.");
    }
    // The key is matched with = as data (never a pattern), so it can only ever identify this one owner.
    return this.inTransaction(() => {
      if (one<{ n: number }>(this.stmts.countSharedObservationsForOwner, key)!.n === 0) {
        return { ownerKey: key, existed: false, observationsDeleted: 0, sourcesDeleted: 0 };
      }
      const sourcesDeleted = Number(this.stmts.deleteSharedSourcesForOwner.run(key).changes);
      const observationsDeleted = Number(this.stmts.deleteSharedObservationsForOwner.run(key).changes);
      const cutoff = one<{ n: number }>(this.stmts.highestSnapshotId)!.n;
      this.stmts.upsertOwnerClear.run(key, cutoff, Math.floor(Date.now() / 1000));
      return { ownerKey: key, existed: true, observationsDeleted, sourcesDeleted };
    });
  }

  backfillSharedStorage(): SharedStorageBackfillResult {
    return this.inTransaction(() => {
      const now = Math.floor(Date.now() / 1000);
      const result: SharedStorageBackfillResult = { snapshotsWithSharedSections: 0, observationsAdded: 0, sourcesAdded: 0, suppressedByDeletion: 0 };
      // Per owner: the snapshots stored before that owner's history was explicitly deleted stay excluded.
      const cutoffs = new Map(
        many<{ owner_key: string; cleared_through_snapshot_id: number }>(this.stmts.allOwnerClears).map((r) => [r.owner_key, r.cleared_through_snapshot_id]),
      );
      const rows = many<SnapshotRow & { c_identity_key: string; c_name: string; c_realm: string }>(this.stmts.snapshotsWithSharedSections);
      for (const row of rows) {
        const parsed = JSON.parse(row.parsed_json) as ParsedSnapshot;
        if (!parsed.accountBank && !parsed.guildBank) continue;
        result.snapshotsWithSharedSections++;
        const { outcomes, suppressed } = this.recordSharedStorage(
          parsed,
          {
            snapshotId: row.id,
            sourceIdentityKey: row.c_identity_key,
            sourceName: row.c_name,
            sourceRealm: row.c_realm,
            exportObservedAt: snapshotObservedAt(row.generated_at, row.imported_at),
          },
          now,
          (key) => row.id <= (cutoffs.get(key) ?? 0),
        );
        result.suppressedByDeletion += suppressed;
        for (const outcome of outcomes) {
          if (outcome.outcome === "recorded") result.observationsAdded++;
          if (outcome.outcome === "recorded" || outcome.outcome === "source-added") result.sourcesAdded++;
        }
      }
      this.stmts.setMeta.run(SHARED_BACKFILL_KEY, SHARED_BACKFILL_VERSION);
      return result;
    });
  }

  deleteCharacter(identityKey: string): DeleteCharacterResult | undefined {
    const row = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    if (!row) return undefined;
    // The snapshots.character_id foreign key is declared but SQLite does
    // not enforce it unless PRAGMA foreign_keys is on, so children are
    // deleted explicitly, first, inside one transaction: a failure part-way
    // rolls everything back rather than leaving orphaned snapshots (which
    // would no longer be reachable through any character) or a character
    // with a partial history.
    return this.inTransaction(() => {
      this.stmts.deleteCurrenciesForCharacter.run(row.id);
      this.stmts.deleteCurrencySectionsForCharacter.run(row.id);
      this.stmts.deleteEquipmentObservationsForCharacter.run(row.id);
      const snapshotsDeleted = Number(this.stmts.deleteSnapshotsForCharacter.run(row.id).changes);
      this.stmts.deleteCharacterById.run(row.id);
      return {
        identityKey: row.identity_key,
        version: row.version as VersionOrUnknown,
        realm: row.realm,
        name: row.name,
        snapshotsDeleted,
      };
    });
  }

  private summarize(characterId: number): StoredCharacterSummary | undefined {
    const row = one<CharacterRow>(this.db.prepare("SELECT * FROM characters WHERE id = ?"), characterId);
    if (!row) return undefined;
    const latest = one<SnapshotRow>(this.stmts.latestSnapshotForCharacter, characterId);
    const count = one<{ n: number }>(this.stmts.snapshotCountForCharacter, characterId)!.n;
    const surname = latest ? toStoredSnapshot(latest).parsed.character.surname : undefined;
    const surnameSource = latest ? toStoredSnapshot(latest).parsed.character.surnameSource : undefined;
    return {
      id: row.id,
      version: row.version as VersionOrUnknown,
      realm: row.realm,
      name: row.name,
      ...(surname ? { surname } : {}),
      ...(surnameSource ? { surnameSource } : {}),
      identityKey: row.identity_key,
      class: row.class ?? undefined,
      faction: row.faction ?? undefined,
      latestLevel: latest?.level ?? undefined,
      latestMoneyCopper: latest?.money_copper ?? undefined,
      latestPlayedSeconds: latest?.played_seconds ?? undefined,
      latestGeneratedAt: latest?.generated_at ?? undefined,
      latestImportedAt: latest?.imported_at,
      snapshotCount: count,
    };
  }

  listVersions(): VersionSummary[] {
    const rows = many<CharacterRow>(this.stmts.allCharacters);
    const byVersion = new Map<string, CharacterRow[]>();
    for (const row of rows) {
      const list = byVersion.get(row.version) ?? [];
      list.push(row);
      byVersion.set(row.version, list);
    }
    const summaries: VersionSummary[] = [];
    for (const [version, chars] of byVersion) {
      let totalMoneyCopper = 0;
      let charactersWithKnownGold = 0;
      let totalPlayedSeconds = 0;
      let charactersWithKnownPlaytime = 0;
      let lastUpdatedAt: number | undefined;
      for (const c of chars) {
        const latest = one<SnapshotRow>(this.stmts.latestSnapshotForCharacter, c.id);
        if (latest?.money_copper != null) {
          totalMoneyCopper += latest.money_copper;
          charactersWithKnownGold++;
        }
        if (latest?.played_seconds != null) {
          totalPlayedSeconds += latest.played_seconds;
          charactersWithKnownPlaytime++;
        }
        if (latest) {
          const observedAt = snapshotObservedAt(latest.generated_at, latest.imported_at);
          if (lastUpdatedAt === undefined || observedAt > lastUpdatedAt) lastUpdatedAt = observedAt;
        }
      }
      summaries.push({
        version: version as VersionOrUnknown,
        characterCount: chars.length,
        // A sum over zero observed values is "unknown", not 0 (see VersionSummary).
        totalMoneyCopper: charactersWithKnownGold > 0 ? totalMoneyCopper : undefined,
        charactersWithKnownGold,
        totalPlayedSeconds: charactersWithKnownPlaytime > 0 ? totalPlayedSeconds : undefined,
        charactersWithKnownPlaytime,
        lastUpdatedAt,
      });
    }
    return summaries;
  }

  listCharacters(version: VersionOrUnknown): StoredCharacterSummary[] {
    const rows = many<CharacterRow>(this.stmts.charactersByVersion, version);
    return rows.map((row) => this.summarize(row.id)!);
  }

  getCharacter(identityKey: string): StoredCharacterSummary | undefined {
    const row = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    if (!row) return undefined;
    return this.summarize(row.id);
  }

  listSnapshots(identityKey: string): StoredSnapshot[] {
    const row = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    if (!row) return [];
    const rows = many<SnapshotRow>(this.stmts.snapshotsForCharacter, row.id);
    return rows.map(toStoredSnapshot);
  }

  listEquipmentObservations(identityKey: string): StoredEquipmentObservation[] {
    const row = one<CharacterRow>(this.stmts.findCharacterByKey, identityKey);
    if (!row || row.version !== "retail") return [];
    return many<{ snapshot_id: number; observed_at: number; capture: number; revision: number; completeness: "complete" | "partial"; evidence_json: string }>(this.stmts.equipmentObservationsForCharacter, row.id).map((entry) => ({
      snapshotId: entry.snapshot_id, observedAt: entry.observed_at, capture: entry.capture, revision: entry.revision,
      completeness: entry.completeness, evidence: JSON.parse(entry.evidence_json) as Record<string, unknown>,
    }));
  }

  getSnapshot(id: number): StoredSnapshot | undefined {
    const row = one<SnapshotRow>(this.stmts.snapshotById, id);
    return row ? toStoredSnapshot(row) : undefined;
  }

  /** Every character in `version` with 2+ snapshots, diffed against its immediately preceding snapshot — unfiltered (includes zero-delta diffs). */
  private allDiffs(version: VersionOrUnknown): RecentChange[] {
    const characters = many<CharacterRow>(this.stmts.charactersByVersion, version);
    const results: RecentChange[] = [];
    for (const character of characters) {
      const rows = many<SnapshotRow>(this.stmts.snapshotsForCharacter, character.id);
      if (rows.length < 2) continue;
      const [latest, previous] = rows;
      const diff: SnapshotDiff = diffSnapshots(toStoredSnapshot(previous).parsed, toStoredSnapshot(latest).parsed);
      results.push({
        characterId: character.id,
        identityKey: character.identity_key,
        characterName: character.name,
        version: character.version as VersionOrUnknown,
        snapshotId: latest.id,
        importedAt: latest.imported_at,
        observedAt: snapshotObservedAt(latest.generated_at, latest.imported_at),
        diff,
      });
    }
    return results;
  }

  /**
   * Meaningful consecutive-pair changes for one version, newest observation first.
   * Pass a positive `limit` to slice; omit it (undefined) to return the full meaningful set.
   * Display caps belong after realm scoping (web), not as a store default.
   */
  recentChanges(version: VersionOrUnknown, limit?: number): RecentChange[] {
    const changes = this.allDiffs(version).filter(({ diff }) => {
      return (
        diff.level.delta ||
        diff.moneyCopper.delta ||
        diff.professions.length > 0 ||
        diff.bagsItems.length > 0 ||
        diff.bankItems.length > 0 ||
        diff.equipment.length > 0 ||
        diff.location.changed ||
        diff.trainerUnlocks.length > 0
        || diff.characterStateChanges.length > 0
      );
    });
    // Newest OBSERVATION first (an old export imported late must not rank as "just now").
    changes.sort((a, b) => b.observedAt - a.observedAt || a.identityKey.localeCompare(b.identityKey));
    if (typeof limit === "number" && limit > 0) return changes.slice(0, limit);
    return changes;
  }

  buildAccountFacts(version: VersionOrUnknown, now: number = Math.floor(Date.now() / 1000)): AccountFacts {
    const characters = this.listCharacters(version);
    const latestParsed = new Map<string, ParsedSnapshot>();
    for (const character of characters) {
      const latestRow = one<SnapshotRow>(this.stmts.latestSnapshotForCharacter, character.id);
      if (latestRow) latestParsed.set(character.identityKey, toStoredSnapshot(latestRow).parsed);
    }
    const allDiffs = this.allDiffs(version);
    const diffs = new Map(allDiffs.map((d) => [d.identityKey, d.diff]));
    const meaningfulChanges = this.recentChanges(version);
    return buildAccountFacts({ version, characters, latestParsed, diffs, meaningfulChanges }, now);
  }

  buildAccountContext(now: number = Math.floor(Date.now() / 1000)): AccountContext {
    const versionFacts = {} as Record<WowVersion, AccountFacts>;
    const characterSnapshots = new Map<string, ReturnType<typeof this.listSnapshots>>();
    const foreverGearObservations = new Map<string, ReturnType<DashboardReadModel["getForeverGearObservation"]>>();
    const foreverGearAllocations = new Map<string, ReturnType<DashboardReadModel["getForeverGearAllocation"]>>();
    for (const version of WOW_VERSIONS) {
      const facts = this.buildAccountFacts(version, now);
      versionFacts[version] = facts;
      for (const character of facts.characters) {
        characterSnapshots.set(character.identityKey, this.listSnapshots(character.identityKey));
      }
    }
    const readModel = new DashboardReadModel(this, () => now);
    for (const character of versionFacts.forever.characters) {
      foreverGearObservations.set(character.identityKey, readModel.getForeverGearObservation({ version: "forever", name: character.name, realm: character.realm }));
      foreverGearAllocations.set(character.identityKey, readModel.getForeverGearAllocation({ version: "forever", name: character.name, realm: character.realm }));
    }
    const erpProjects = WOW_VERSIONS.flatMap((version) => readModel.getErpProjects({ version }));
    return buildAccountContextPure({ now, versionFacts, characterSnapshots, foreverGearObservations, foreverGearAllocations, erpProjects });
  }

  // --- Explicit Demand (see demand.ts) -----------------------------------------------------------------
  //
  // Persistence only; every rule (validation, conflict key, enrichment-vs-observation distinctions) is
  // in demand.ts. Demand represents CURRENT user intent: rows are mutated in place, never superseded by
  // an immutable chain. There is deliberately no reference to characters or snapshots.

  listDemands(version: VersionOrUnknown): ExplicitDemand[] {
    if (version !== "retail") return [];
    return many<DemandRow>(this.stmts.demandsForVersion, version).map((row) => storedDemandToExplicitDemand(toStoredDemand(row)));
  }

  listErpProjects(version: VersionOrUnknown): ErpProject[] {
    if (version === "unknown-version") return [];
    const rows = many<{ project_json: string }>(this.db.prepare("SELECT project_json FROM erp_projects WHERE game_version = ? ORDER BY updated_at DESC, stable_id"), version);
    return rows.map((row) => JSON.parse(row.project_json) as ErpProject);
  }

  listErpProjectHistory(stableId: string, limit = 50): ErpProjectEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("ERP project history limit must be between 1 and 200.");
    const rows = many<{ event_json: string }>(this.db.prepare("SELECT event_json FROM erp_project_events WHERE project_id = ? ORDER BY revision DESC LIMIT ?"), stableId, limit);
    return rows.map((row) => JSON.parse(row.event_json) as ErpProjectEvent);
  }

  countErpProjectHistory(stableId: string): number {
    const row = one<{ event_count: number }>(this.db.prepare("SELECT COUNT(*) AS event_count FROM erp_project_events WHERE project_id = ?"), stableId);
    return row?.event_count ?? 0;
  }

  private recordErpProjectEvent(project: ErpProject, kind: ErpProjectEvent["kind"], changedFields: string[], fromStatus?: ErpProject["status"], workOrderStatusChanges?: ErpProjectEvent["workOrderStatusChanges"]): void {
    const event: ErpProjectEvent = {
      eventId: `project_event_${randomUUID()}`, projectId: project.stableId, version: project.version,
      revision: project.revision, occurredAt: project.updatedAt, kind, changedFields,
      ...(workOrderStatusChanges !== undefined && workOrderStatusChanges.length > 0 ? { workOrderStatusChanges } : {}),
      ...(fromStatus !== undefined ? { fromStatus } : {}), toStatus: project.status,
    };
    this.db.prepare("INSERT INTO erp_project_events(event_id, project_id, game_version, revision, occurred_at, event_json) VALUES(?,?,?,?,?,?)")
      .run(event.eventId, event.projectId, event.version, event.revision, event.occurredAt, JSON.stringify(event));
  }

  getErpProject(stableId: string): ErpProject | undefined {
    const row = one<{ project_json: string }>(this.db.prepare("SELECT project_json FROM erp_projects WHERE stable_id = ?"), stableId);
    return row ? JSON.parse(row.project_json) as ErpProject : undefined;
  }

  createErpProject(input: ErpProjectDraft): ErpProject {
    const now = Math.floor(Date.now() / 1000);
    const project: ErpProject = {
      stableId: `project_${randomUUID()}`, version: input.version, title: input.title.trim(),
      ...(input.objective !== undefined ? { objective: input.objective.trim() } : {}), status: input.status ?? "ACTIVE", priority: input.priority ?? 3,
      createdAt: now, updatedAt: now, revision: 1, needs: input.needs ?? [], reservations: input.reservations ?? [], workOrders: input.workOrders ?? [],
    };
    validateErpProject(project, (key) => this.getCharacter(key)?.version === project.version);
    this.inTransaction(() => {
      this.db.prepare("INSERT INTO erp_projects(stable_id, game_version, revision, project_json, created_at, updated_at) VALUES(?,?,?,?,?,?)")
        .run(project.stableId, project.version, project.revision, JSON.stringify(project), project.createdAt, project.updatedAt);
      this.recordErpProjectEvent(project, "CREATED", ["project"]);
    });
    return project;
  }

  updateErpProject(project: ErpProject, expectedRevision: number): ErpProject | undefined {
    return this.inTransaction(() => {
      const existing = this.getErpProject(project.stableId);
      if (!existing) return undefined;
      if (!Number.isSafeInteger(expectedRevision) || existing.revision !== expectedRevision) throw new ErpProjectConflictError();
      if (project.version !== existing.version || project.createdAt !== existing.createdAt) throw new TypeError("Project version and creation time are immutable.");
      const trackedFields = ["title", "objective", "status", "completionNote", "priority", "needs", "reservations", "workOrders"] as const;
      const changedFields = trackedFields.filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(project[field]));
      const updated: ErpProject = { ...project, updatedAt: Math.floor(Date.now() / 1000), revision: expectedRevision + 1 };
      validateErpProject(updated, (key) => this.getCharacter(key)?.version === updated.version);
      const result = this.db.prepare("UPDATE erp_projects SET revision = ?, project_json = ?, updated_at = ? WHERE stable_id = ? AND revision = ?")
        .run(updated.revision, JSON.stringify(updated), updated.updatedAt, updated.stableId, expectedRevision);
      if (Number(result.changes) !== 1) throw new ErpProjectConflictError();
      const kind = existing.status !== updated.status ? "STATUS_CHANGED" : "UPDATED";
      const previousWorkOrders = new Map(existing.workOrders.map((order) => [order.stableId, order]));
      const workOrderStatusChanges = updated.workOrders.flatMap((order) => {
        const previous = previousWorkOrders.get(order.stableId);
        if (previous?.status === order.status) return [];
        return [{ workOrderId: order.stableId, title: order.title, ...(previous ? { fromStatus: previous.status } : {}), toStatus: order.status }];
      });
      this.recordErpProjectEvent(updated, kind, changedFields, existing.status !== updated.status ? existing.status : undefined, workOrderStatusChanges);
      return updated;
    });
  }

  setErpProjectStatus(stableId: string, status: ErpProject["status"], expectedRevision: number): ErpProject | undefined {
    const project = this.getErpProject(stableId);
    if (!project) return undefined;
    return this.updateErpProject({ ...project, status }, expectedRevision);
  }

  getActiveDemand(version: VersionOrUnknown, demandType: DemandType, baseItemId: number): ExplicitDemand | undefined {
    if (version !== "retail") return undefined;
    const row = one<DemandRow>(this.stmts.activeDemandByKey, version, demandType, baseItemId);
    return row ? storedDemandToExplicitDemand(toStoredDemand(row)) : undefined;
  }

  createDemand(input: CreateDemandInput): ExplicitDemand {
    const validated = validateCreateDemandInput(input);
    const existing = one<DemandRow>(this.stmts.activeDemandByKey, "retail", validated.demandType, validated.baseItemId);
    if (existing) throw new DemandConflictError(existing.stable_id);
    const now = Math.floor(Date.now() / 1000);
    const stableId = `demand_${randomUUID()}`;
    this.stmts.insertDemand.run(stableId, "retail", validated.demandType, validated.baseItemId, validated.requiredQuantity, validated.purpose ?? null, now, now);
    return storedDemandToExplicitDemand(toStoredDemand(one<DemandRow>(this.stmts.demandByStableId, stableId)!));
  }

  updateDemand(stableId: string, input: UpdateDemandInput): ExplicitDemand | undefined {
    const validated = validateUpdateDemandInput(input);
    const existing = one<DemandRow>(this.stmts.demandByStableId, stableId);
    if (!existing) return undefined;
    const requiredQuantity = validated.requiredQuantity ?? existing.required_quantity;
    const purpose = validated.purpose !== undefined ? validated.purpose : existing.purpose;
    const now = Math.floor(Date.now() / 1000);
    this.stmts.updateDemandFields.run(requiredQuantity, purpose, now, stableId);
    return storedDemandToExplicitDemand(toStoredDemand(one<DemandRow>(this.stmts.demandByStableId, stableId)!));
  }

  deactivateDemand(stableId: string): ExplicitDemand | undefined {
    const existing = one<DemandRow>(this.stmts.demandByStableId, stableId);
    if (!existing) return undefined;
    this.stmts.deactivateDemandRow.run(Math.floor(Date.now() / 1000), stableId);
    return storedDemandToExplicitDemand(toStoredDemand(one<DemandRow>(this.stmts.demandByStableId, stableId)!));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * External-consumer SQLite entry point. It owns a DatabaseSync connection
 * opened with Node's readOnly option and exposes only SnapshotReadStore.
 * It never runs WAL/schema setup or the shared-storage backfill.
 */
export class SqliteSnapshotReadStore implements SnapshotReadStore {
  private readonly store: SqliteSnapshotStore;

  constructor(path: string) {
    this.store = new SqliteSnapshotStore(path, { readOnly: true });
  }

  getCharacterCurrencies(identityKey: string): CharacterCurrencies | undefined {
    return this.store.getCharacterCurrencies(identityKey);
  }
  getCharacterCurrenciesForSnapshot(identityKey: string, snapshotId: number): CharacterCurrencies | undefined {
    return this.store.getCharacterCurrenciesForSnapshot(identityKey, snapshotId);
  }
  listVersionCurrencies(version: VersionOrUnknown): AccountCurrencies {
    return this.store.listVersionCurrencies(version);
  }
  getItemMetadata(version: VersionOrUnknown, baseItemIds: readonly number[]): ItemMetadataView[] {
    return this.store.getItemMetadata(version, baseItemIds);
  }
  projectSharedStorage(): SharedStorageProjection {
    return this.store.projectSharedStorage();
  }
  loadSharedJournal(): SharedJournal {
    return this.store.loadSharedJournal();
  }
  listVersions(): VersionSummary[] {
    return this.store.listVersions();
  }
  listCharacters(version: VersionOrUnknown): StoredCharacterSummary[] {
    return this.store.listCharacters(version);
  }
  listSnapshots(identityKey: string): StoredSnapshot[] {
    return this.store.listSnapshots(identityKey);
  }
  listEquipmentObservations(identityKey: string): StoredEquipmentObservation[] {
    return this.store.listEquipmentObservations(identityKey);
  }
  buildAccountFacts(version: VersionOrUnknown, now?: number): AccountFacts {
    return this.store.buildAccountFacts(version, now);
  }
  listDemands(version: VersionOrUnknown): ExplicitDemand[] {
    return this.store.listDemands(version);
  }
  listErpProjects(version: VersionOrUnknown): ErpProject[] {
    return this.store.listErpProjects(version);
  }
  listErpProjectHistory(stableId: string, limit = 50): ErpProjectEvent[] {
    return this.store.listErpProjectHistory(stableId, limit);
  }
  countErpProjectHistory(stableId: string): number {
    return this.store.countErpProjectHistory(stableId);
  }
  getErpProject(stableId: string): ErpProject | undefined {
    return this.store.getErpProject(stableId);
  }
  getActiveDemand(version: VersionOrUnknown, demandType: DemandType, baseItemId: number): ExplicitDemand | undefined {
    return this.store.getActiveDemand(version, demandType, baseItemId);
  }
  close(): void {
    this.store.close();
  }
}
