import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { buildAccountFacts, type AccountFacts } from "./accountFacts.ts";
import { buildAccountContext as buildAccountContextPure, type AccountContext } from "./accountContext.ts";
import { SNAPSHOTS_NEWEST_FIRST_SQL, normalizeExportText, snapshotObservedAt } from "./chronology.ts";
import { characterIdentity } from "./identity.ts";
import { diffSnapshots, type SnapshotDiff } from "./diff.ts";
import { parseWowSyncExport } from "./parser.ts";
import type { ParsedSnapshot, VersionOrUnknown, WowVersion } from "./types.ts";
import { WOW_VERSIONS, detectVersion } from "./version.ts";
import type {
  DeleteCharacterResult,
  ImportResult,
  RecentChange,
  SnapshotStore,
  StoredCharacterSummary,
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
`;

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

export class SqliteSnapshotStore implements SnapshotStore {
  private db: DatabaseSync;
  private stmts: Record<string, StatementSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
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
      snapshotById: this.db.prepare("SELECT * FROM snapshots WHERE id = ?"),
      deleteSnapshotsForCharacter: this.db.prepare("DELETE FROM snapshots WHERE character_id = ?"),
      deleteCharacterById: this.db.prepare("DELETE FROM characters WHERE id = ?"),
    };
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

  importSnapshot(raw: string): ImportResult {
    // Parse first: a malformed export throws before anything is written.
    const parsed = parseWowSyncExport(raw);
    const version = detectVersion(parsed.character);
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
          return {
            character: this.summarize(characterRow.id)!,
            snapshot: toStoredSnapshot(existing),
            previousSnapshot: undefined,
            diff: undefined,
            isFirstSnapshot: false,
            isDuplicate: true,
            isLatest: newest?.id === existing.id,
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

      return {
        character: this.summarize(characterRow.id)!,
        snapshot,
        previousSnapshot,
        diff,
        isFirstSnapshot: rows.length === 1,
        isDuplicate: false,
        isLatest,
      };
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
    return {
      id: row.id,
      version: row.version as VersionOrUnknown,
      realm: row.realm,
      name: row.name,
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

  recentChanges(version: VersionOrUnknown, limit = 20): RecentChange[] {
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
      );
    });
    // Newest OBSERVATION first (an old export imported late must not rank as "just now").
    changes.sort((a, b) => b.observedAt - a.observedAt || a.identityKey.localeCompare(b.identityKey));
    return changes.slice(0, limit);
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
    for (const version of WOW_VERSIONS) {
      const facts = this.buildAccountFacts(version, now);
      versionFacts[version] = facts;
      for (const character of facts.characters) {
        characterSnapshots.set(character.identityKey, this.listSnapshots(character.identityKey));
      }
    }
    return buildAccountContextPure({ now, versionFacts, characterSnapshots });
  }

  close(): void {
    this.db.close();
  }
}
