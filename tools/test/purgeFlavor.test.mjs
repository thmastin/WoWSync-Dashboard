import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../../packages/core/src/sqliteStore.ts";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-purge-"));
  const dbPath = path.join(dir, "db.sqlite");
  const store = new SqliteSnapshotStore(dbPath);
  store.close();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    INSERT INTO characters(id,version,realm,name,identity_key,created_at) VALUES
      (1,'forever','Test','BetaOne','forever::test::betaone',1),
      (2,'classic-era','Test','EraOne','classic-era::test::eraone',1);
    INSERT INTO snapshots(id,character_id,imported_at,raw_text,parsed_json) VALUES
      (11,1,1,'beta','{}'),(12,2,1,'era','{}');
    INSERT INTO snapshot_currency_sections(snapshot_id,character_id,list_read,entry_count,dropped_entries,stored_at) VALUES (11,1,1,0,0,1),(12,2,1,0,0,1);
    INSERT INTO snapshot_currencies(snapshot_id,character_id,currency_id) VALUES (11,1,7),(12,2,7);
    INSERT INTO snapshot_equipment_observations(character_id,snapshot_id,observed_at,capture,revision,completeness,evidence_json,stored_at) VALUES (1,11,1,1,1,'complete','{}',1),(2,12,1,1,1,'complete','{}',1);
    INSERT INTO shared_observations(id,identity,owner_key,owner_kind,owner_json,claimed_observed_at,completeness,content_hash,hash_version,content_json,created_at)
      VALUES (1,'forever-ob','forever::guild::x','guild','{}',1,'complete','a',1,'{}',1),(2,'era-ob','classic-era::guild::y','guild','{}',1,'complete','b',1,'{}',1);
    INSERT INTO shared_observation_sources(observation_id,snapshot_id,carrier_state,export_observed_at,source_identity_key,source_name,source_realm) VALUES
      (1,11,'OBSERVED',1,'forever::test::betaone','BetaOne','Test'),(2,12,'OBSERVED',1,'classic-era::test::eraone','EraOne','Test');
    INSERT INTO shared_owner_clears(owner_key,cleared_through_snapshot_id,cleared_at) VALUES ('forever::guild::x',11,1),('classic-era::guild::y',12,1);
    INSERT INTO item_metadata_evidence(game_version,base_item_id,facet,source,value,first_seen_at,last_seen_at,client_builds) VALUES ('forever',1,'classID','game-client',2,1,1,'[]'),('classic-era',1,'classID','game-client',2,1,1,'[]');
    INSERT INTO store_meta(key,value) VALUES
      ('mail-plan-settings:v1:%5B%22default%22%2C%22forever%22%2C%22Test%22%2C%22Alliance%22%5D','{"accountId":"default","version":"forever","realm":"Test","faction":"Alliance","plannedProfessionsByCharacter":{"forever::test::betaone":["Tailoring"]},"updatedAt":1,"provenance":"USER_CONFIGURED"}'),
      ('mail-plan-settings:v1:%5B%22default%22%2C%22classic-era%22%2C%22Test%22%2C%22Alliance%22%5D','{"accountId":"default","version":"classic-era","realm":"Test","faction":"Alliance","plannedProfessionsByCharacter":{"classic-era::test::eraone":["Alchemy"]},"updatedAt":1,"provenance":"USER_CONFIGURED"}'),
      ('unrelated','keep');
    INSERT INTO erp_projects(stable_id,game_version,revision,project_json,created_at,updated_at) VALUES ('forever-project','forever',1,'{}',1,1);
    CREATE TABLE reference_codex_builds(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE reference_codex_records(id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO reference_codex_builds VALUES (1,'build'); INSERT INTO reference_codex_records VALUES (1,'record');
  `);
  db.close();
  return { dir, dbPath };
}
function cli(dbPath, ...args) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/purgeFlavor.mjs", ...args], { cwd: path.resolve("."), env: { ...process.env, WOWSYNC_DB_PATH: dbPath }, encoding: "utf8" });
}
function hash(file) {
  const db = new DatabaseSync(file);
  const value = JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  db.close();
  return createHash("sha256").update(value).digest("hex");
}

test("purge flavor is explicit, dry-run is read-only, and confirm preserves other versions", () => {
  const { dir, dbPath } = fixture();
  let db;
  try {
    const before = hash(dbPath);
    const beforeDb = new DatabaseSync(dbPath);
    const scopedCounts = {
      characters: "SELECT COUNT(*) AS n FROM characters WHERE version='classic-era'",
      snapshots: "SELECT COUNT(*) AS n FROM snapshots s JOIN characters c ON c.id=s.character_id WHERE c.version='classic-era'",
      snapshot_currency_sections: "SELECT COUNT(*) AS n FROM snapshot_currency_sections x JOIN characters c ON c.id=x.character_id WHERE c.version='classic-era'",
      snapshot_currencies: "SELECT COUNT(*) AS n FROM snapshot_currencies x JOIN characters c ON c.id=x.character_id WHERE c.version='classic-era'",
      snapshot_equipment_observations: "SELECT COUNT(*) AS n FROM snapshot_equipment_observations x JOIN characters c ON c.id=x.character_id WHERE c.version='classic-era'",
      shared_observations: "SELECT COUNT(*) AS n FROM shared_observations WHERE owner_key LIKE 'classic-era::%'",
      shared_observation_sources: "SELECT COUNT(*) AS n FROM shared_observation_sources x JOIN snapshots s ON s.id=x.snapshot_id JOIN characters c ON c.id=s.character_id WHERE c.version='classic-era'",
      shared_owner_clears: "SELECT COUNT(*) AS n FROM shared_owner_clears WHERE owner_key LIKE 'classic-era::%'",
      item_metadata_evidence: "SELECT COUNT(*) AS n FROM item_metadata_evidence WHERE game_version='classic-era'",
    };
    const classicCounts = Object.fromEntries(Object.entries(scopedCounts).map(([table, sql]) => [table, Number(beforeDb.prepare(sql).get().n)]));
    beforeDb.close();
    const missing = cli(dbPath, "--version", "forever");
    assert.notEqual(missing.status, 0);
    const unknown = cli(dbPath, "--version", "hardcore", "--dry-run");
    assert.notEqual(unknown.status, 0);
    const dry = cli(dbPath, "--version", "forever", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout).characters, ["BetaOne-Test"]);
    assert.equal(hash(dbPath), before, "dry run must not write");
    const result = cli(dbPath, "--version", "forever", "--confirm");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "PURGED");
    assert.ok(readdirSync(dir).some((name) => name.startsWith("db.sqlite.bak-purge-forever-")));
    db = new DatabaseSync(dbPath);
    const remaining = [
      ["characters", "version='forever'"],
      ["snapshots", "character_id IN (SELECT id FROM characters WHERE version='forever')"],
      ["snapshot_currency_sections", "character_id IN (SELECT id FROM characters WHERE version='forever')"],
      ["snapshot_currencies", "character_id IN (SELECT id FROM characters WHERE version='forever')"],
      ["snapshot_equipment_observations", "character_id IN (SELECT id FROM characters WHERE version='forever')"],
      ["shared_observations", "owner_key LIKE 'forever::%'"],
      ["shared_observation_sources", "snapshot_id IN (SELECT s.id FROM snapshots s JOIN characters c ON c.id=s.character_id WHERE c.version='forever')"],
      ["shared_owner_clears", "owner_key LIKE 'forever::%'"],
      ["item_metadata_evidence", "game_version='forever'"],
    ];
    for (const [table, where] of remaining) assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n), 0, `${table} forever data removed`);
    assert.deepEqual(db.prepare("SELECT name,realm,version FROM characters").all().map((row) => ({ ...row })), [{ name: "EraOne", realm: "Test", version: "classic-era" }]);
    const afterClassicCounts = Object.fromEntries(Object.entries(scopedCounts).map(([table, sql]) => [table, Number(db.prepare(sql).get().n)]));
    assert.deepEqual(afterClassicCounts, classicCounts);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM reference_codex_builds").get().n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM reference_codex_records").get().n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM erp_projects WHERE game_version='forever'").get().n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM shared_observation_sources WHERE observation_id NOT IN (SELECT id FROM shared_observations)").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM snapshot_currency_sections WHERE character_id NOT IN (SELECT id FROM characters) OR snapshot_id NOT IN (SELECT id FROM snapshots)").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM snapshot_currencies WHERE character_id NOT IN (SELECT id FROM characters) OR snapshot_id NOT IN (SELECT id FROM snapshots)").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM snapshot_equipment_observations WHERE character_id NOT IN (SELECT id FROM characters) OR snapshot_id NOT IN (SELECT id FROM snapshots)").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM store_meta WHERE key='unrelated'").get().n), 1);
    assert.match(db.prepare("SELECT value FROM store_meta WHERE key LIKE '%classic-era%'").get().value, /classic-era/);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
