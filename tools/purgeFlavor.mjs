import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const versions = new Set(["retail", "tbc-anniversary", "classic-era", "forever"]);

export function parseArgs(args) {
  let version;
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" && version === undefined && args[i + 1] && !args[i + 1].startsWith("--")) version = args[++i];
    else if ((arg === "--dry-run" || arg === "--confirm") && mode === undefined) mode = arg.slice(2);
    else throw new Error(`Unexpected or duplicate argument: ${arg}`);
  }
  if (!version || !versions.has(version)) throw new Error(`--version must be one of: ${[...versions].join(", ")}`);
  if (!mode) throw new Error("Specify exactly one of --dry-run or --confirm.");
  return { version, mode };
}

const count = (db, sql, ...args) => Number(db.prepare(sql).get(...args).n);
const childTables = [
  ["shared_observation_sources", "snapshot_id IN (SELECT id FROM snapshots WHERE character_id IN (SELECT id FROM characters WHERE version = ?)) OR observation_id IN (SELECT id FROM shared_observations WHERE owner_key LIKE ?)", (v) => [v, `${v}::%`]],
  ["snapshot_currency_sections", "character_id IN (SELECT id FROM characters WHERE version = ?)", (v) => [v]],
  ["snapshot_currencies", "character_id IN (SELECT id FROM characters WHERE version = ?) OR snapshot_id IN (SELECT id FROM snapshots WHERE character_id IN (SELECT id FROM characters WHERE version = ?))", (v) => [v, v]],
  ["snapshot_equipment_observations", "character_id IN (SELECT id FROM characters WHERE version = ?) OR snapshot_id IN (SELECT id FROM snapshots WHERE character_id IN (SELECT id FROM characters WHERE version = ?))", (v) => [v, v]],
];

function tableExists(db, table) {
  return count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", table) > 0;
}

function mailSettingsPlan(db, version, identityKeys) {
  if (!tableExists(db, "store_meta")) return [];
  const rows = db.prepare("SELECT key, value FROM store_meta WHERE key LIKE 'mail-plan-settings:%'").all();
  return rows.flatMap((row) => {
    let keyScope;
    try { keyScope = JSON.parse(decodeURIComponent(row.key.slice("mail-plan-settings:v1:".length))); } catch { return []; }
    let value;
    try { value = JSON.parse(row.value); } catch { return []; }
    if (keyScope?.[1] === version || value?.version === version) return [{ key: row.key, value: null }];
    let changed = false;
    for (const field of ["auctionCharacterIdentityKey", "mainCharacterIdentityKey"]) {
      if (identityKeys.has(value?.[field])) { delete value[field]; changed = true; }
    }
    if (value?.plannedProfessionsByCharacter && typeof value.plannedProfessionsByCharacter === "object") {
      for (const identity of identityKeys) if (Object.hasOwn(value.plannedProfessionsByCharacter, identity)) { delete value.plannedProfessionsByCharacter[identity]; changed = true; }
      if (!Object.keys(value.plannedProfessionsByCharacter).length) delete value.plannedProfessionsByCharacter;
    }
    return changed ? [{ key: row.key, value: JSON.stringify(value) }] : [];
  });
}

export function purgeReport(db, version) {
  const characters = db.prepare("SELECT id, identity_key, name, realm FROM characters WHERE version = ? ORDER BY realm, name").all(version);
  const ids = new Set(characters.map((c) => c.identity_key));
  const byTable = {};
  for (const [table, where, params] of childTables) byTable[table] = tableExists(db, table) ? count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params(version)) : 0;
  const observationIds = tableExists(db, "shared_observations")
    ? db.prepare(`SELECT o.id FROM shared_observations o
        WHERE o.owner_key LIKE ? OR (
          EXISTS (SELECT 1 FROM shared_observation_sources s WHERE s.observation_id=o.id AND s.snapshot_id IN (SELECT x.id FROM snapshots x JOIN characters c ON c.id=x.character_id WHERE c.version=?))
          AND NOT EXISTS (SELECT 1 FROM shared_observation_sources s WHERE s.observation_id=o.id AND s.snapshot_id NOT IN (SELECT x.id FROM snapshots x JOIN characters c ON c.id=x.character_id WHERE c.version=?))
        )`).all(`${version}::%`, version, version).map((row) => Number(row.id))
    : [];
  byTable.shared_observations = observationIds.size;
  byTable.shared_owner_clears = tableExists(db, "shared_owner_clears") ? count(db, "SELECT COUNT(*) AS n FROM shared_owner_clears WHERE owner_key LIKE ?", `${version}::%`) : 0;
  byTable.item_metadata_evidence = tableExists(db, "item_metadata_evidence") ? count(db, "SELECT COUNT(*) AS n FROM item_metadata_evidence WHERE game_version = ?", version) : 0;
  byTable.demands = tableExists(db, "demands") ? count(db, "SELECT COUNT(*) AS n FROM demands WHERE game_version = ?", version) : 0;
  byTable.snapshots = count(db, "SELECT COUNT(*) AS n FROM snapshots WHERE character_id IN (SELECT id FROM characters WHERE version = ?)", version);
  byTable.characters = characters.length;
  const mailSettings = mailSettingsPlan(db, version, ids);
  byTable.mail_plan_settings = mailSettings.length;
  return { version, characters: characters.map(({ name, realm }) => `${name}-${realm}`), counts: byTable, mailSettings, _removedSourceObservationIds: [...observationIds] };
}

export function purgeDatabase(db, version) {
  const plan = purgeReport(db, version);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    for (const [table, where, params] of childTables) if (tableExists(db, table)) run(`DELETE FROM ${table} WHERE ${where}`, ...params(version));
    if (tableExists(db, "shared_observations")) {
      const candidates = plan._removedSourceObservationIds;
      if (candidates.length) run(`DELETE FROM shared_observations WHERE id IN (${candidates.map(() => "?").join(",")})`, ...candidates);
    }
    if (tableExists(db, "shared_owner_clears")) run("DELETE FROM shared_owner_clears WHERE owner_key LIKE ?", `${version}::%`);
    if (tableExists(db, "item_metadata_evidence")) run("DELETE FROM item_metadata_evidence WHERE game_version = ?", version);
    if (tableExists(db, "demands")) run("DELETE FROM demands WHERE game_version = ?", version);
    run("DELETE FROM snapshots WHERE character_id IN (SELECT id FROM characters WHERE version = ?)", version);
    run("DELETE FROM characters WHERE version = ?", version);
    for (const setting of plan.mailSettings) {
      if (setting.value === null) run("DELETE FROM store_meta WHERE key = ?", setting.key);
      else run("UPDATE store_meta SET value = ? WHERE key = ?", setting.value, setting.key);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const { _removedSourceObservationIds, ...publicPlan } = plan;
  return publicPlan;
}

function sqlString(value) { return `'${value.replaceAll("'", "''")}'`; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let db;
  try {
    const { version, mode } = parseArgs(process.argv.slice(2));
    const dbPath = path.resolve(process.env.WOWSYNC_DB_PATH ?? "data/wowsync.sqlite");
    if (!existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
    db = new DatabaseSync(dbPath);
    const report = purgeReport(db, version);
    const { _removedSourceObservationIds, ...publicReport } = report;
    if (mode === "dry-run") {
      console.log(JSON.stringify({ status: "DRY_RUN", ...publicReport }));
    } else {
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const backup = `${dbPath}.bak-purge-${version}-${stamp}`;
      db.exec(`VACUUM INTO ${sqlString(backup)}`);
      const deleted = purgeDatabase(db, version);
      console.log(JSON.stringify({ status: "PURGED", backup, ...deleted }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { db?.close(); }
}
