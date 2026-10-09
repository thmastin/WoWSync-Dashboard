import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { observation, retailExport, sidecar } from "./equipmentObservationFixtures.ts";

/** A minimal valid Retail combatSpecialization domain for the existing characterState sidecar. */
const combatDomain = (specID: number) => ({
  formatVersion: 1, observedAt: 1_791_375_000, completeness: "complete",
  data: { formatVersion: 1, client: { clientFamily: "Retail" }, activeSpec: { specID, classID: 3 } },
});

function freshStore() {
  return new SqliteSnapshotStore(":memory:");
}

test("importing an export creates a character and a first snapshot", () => {
  const store = freshStore();
  try {
    const raw = buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 } });
    const result = store.importSnapshot(raw);
    assert.equal(result.isFirstSnapshot, true);
    assert.equal(result.character.name, "Torahn");
    assert.equal(result.character.version, "tbc-anniversary");
    assert.equal(result.character.snapshotCount, 1);
    assert.equal(result.diff, undefined);
  } finally {
    store.close();
  }
});

test("Forever surname persists in snapshot and latest summaries without changing the canonical key", () => {
  const store = freshStore();
  try {
    const firstText = buildWowSyncExport({ generatedAt: 1_700_000_000, character: {
      name: "Hallo", surname: "Emberstone", surnameSource: "UnitName[2]+GetUnitName suffix", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001",
    } });
    const first = store.importSnapshot(firstText);
    assert.equal(first.snapshot.parsed.character.surname, "Emberstone");
    assert.equal(first.character.surname, "Emberstone");
    assert.equal(first.character.surnameSource, "UnitName[2]+GetUnitName suffix");
    assert.equal(first.character.identityKey, "forever::classic beta pvp 2::hallo");
    assert.equal(store.buildAccountFacts("forever", 1_700_000_001).characters[0]?.surname, "Emberstone");
    assert.equal(store.buildAccountContext(1_700_000_001).versions.forever.characters[0]?.surname, "Emberstone");

    const laterLegacy = buildWowSyncExport({ generatedAt: 1_700_000_010, character: {
      name: "Hallo", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001",
    } });
    const latest = store.importSnapshot(laterLegacy);
    assert.equal(latest.character.identityKey, first.character.identityKey);
    assert.equal(latest.snapshot.parsed.character.surname, undefined);
    assert.equal(store.listCharacters("forever")[0]?.surname, undefined, "missing latest surname is not carried forward as current");
    assert.equal(store.listSnapshots(first.character.identityKey).length, 2);
  } finally { store.close(); }
});

test("gear candidates persist in snapshot JSON, duplicates are idempotent, and separate observations stay separate", () => {
  const store = freshStore();
  try {
    const base = buildWowSyncExport({ generatedAt: 1_700_000_000, character: { name: "RetailOne", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const section = "[GEAR CANDIDATES]\nState: complete; observed=1700000000\nContractVersion: 1\ncandidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t0\t100\t80\t4\t0\tINVTYPE_HEAD\tno\tno\t?\t?\t?\t?\tyes\tOBSERVED";
    const firstRaw = base.replace("\n\n[END]", `\n\n${section}\n\n[END]`);
    const first = store.importSnapshot(firstRaw);
    assert.deepEqual(first.snapshot.parsed.gearCandidates?.rows[0]?.itemID, { state: "KNOWN", value: 123 });
    assert.equal(store.importSnapshot(firstRaw).isDuplicate, true);
    const secondRaw = buildWowSyncExport({ generatedAt: 1_700_000_001, character: { name: "RetailOne", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }).replace("\n\n[END]", `\n\n${section.replaceAll("1700000000", "1700000001")}\n\n[END]`);
    const second = store.importSnapshot(secondRaw);
    assert.notEqual(second.snapshot.id, first.snapshot.id);
    assert.equal(store.listSnapshots(first.character.identityKey).length, 2);
    const otherCharacter = store.importSnapshot(buildWowSyncExport({ character: { name: "RetailTwo", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    assert.equal(otherCharacter.snapshot.parsed.gearCandidates, undefined);
    assert.equal(store.listCharacters("retail").length, 2);
    assert.equal(store.listCharacters("classic-era").length, 0);
  } finally { store.close(); }
});

test("a second import does not destroy the first snapshot, and produces a diff", () => {
  const store = freshStore();
  try {
    const raw1 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 },
      professions: { entries: [{ name: "Mining", skill: 60, maxSkill: 300 }] },
    });
    const raw2 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 22, moneyCopper: 70000 },
      professions: { entries: [{ name: "Mining", skill: 74, maxSkill: 300 }] },
    });
    store.importSnapshot(raw1);
    const result2 = store.importSnapshot(raw2);

    assert.equal(result2.isFirstSnapshot, false);
    assert.equal(result2.character.snapshotCount, 2);
    assert.equal(result2.diff?.level.delta, 2);
    assert.equal(result2.diff?.moneyCopper.delta, 20000);
    assert.equal(result2.diff?.professions[0]?.skill.delta, 14);

    const history = store.listSnapshots(result2.character.identityKey);
    assert.equal(history.length, 2);
    assert.equal(history[0].parsed.character.level, 22);
    assert.equal(history[1].parsed.character.level, 20);
  } finally {
    store.close();
  }
});

test("characters in different WoW versions are never aggregated together", () => {
  const store = freshStore();
  try {
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7", moneyCopper: 10000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", moneyCopper: 700000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Retailchar", realm: "Area52", clientVersion: "12.1.0", clientFamily: "Retail", interface: "120100", moneyCopper: 999999 },
      }),
    );

    const versions = store.listVersions();
    const era = versions.find((v) => v.version === "classic-era")!;
    const tbc = versions.find((v) => v.version === "tbc-anniversary")!;
    const retail = versions.find((v) => v.version === "retail")!;

    assert.equal(era.characterCount, 1);
    assert.equal(era.totalMoneyCopper, 10000);
    assert.equal(tbc.characterCount, 1);
    assert.equal(tbc.totalMoneyCopper, 700000);
    assert.equal(retail.characterCount, 1);
    assert.equal(retail.totalMoneyCopper, 999999);
  } finally {
    store.close();
  }
});

test("same character name on different realms are stored as distinct characters", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7" } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Grobbulus", clientVersion: "1.15.7" } }));
    const chars = store.listCharacters("classic-era");
    assert.equal(chars.length, 2);
    assert.notEqual(chars[0].identityKey, chars[1].identityKey);
  } finally {
    store.close();
  }
});

test("recentChanges surfaces a deterministic level-up across snapshots", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 18 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 19 } }));
    const changes = store.recentChanges("tbc-anniversary");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].characterName, "Voodan");
    assert.equal(changes[0].diff.level.delta, 1);
  } finally {
    store.close();
  }
});

test("recentChanges with no limit returns the full meaningful set; a positive limit slices", () => {
  const store = freshStore();
  try {
    const base = 1_700_000_000;
    for (let i = 0; i < 25; i++) {
      const name = `Alt${String(i).padStart(2, "0")}`;
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + i * 10,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 10 },
      }));
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + i * 10 + 5,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 11 },
      }));
    }
    const all = store.recentChanges("tbc-anniversary");
    assert.equal(all.length, 25);
    assert.equal(store.recentChanges("tbc-anniversary", 5).length, 5);
    assert.equal(store.recentChanges("tbc-anniversary", 20).length, 20);
  } finally {
    store.close();
  }
});

test("buildAccountFacts keeps a realm-B change that would fall outside a version-wide top-20 cap", () => {
  const store = freshStore();
  try {
    const base = 1_700_000_000;
    // 21 newer meaningful changes on realm A dominate a version-wide top-20.
    for (let i = 0; i < 21; i++) {
      const name = `Dom${String(i).padStart(2, "0")}`;
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + 1000 + i * 10,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 20 },
      }));
      store.importSnapshot(buildWowSyncExport({
        generatedAt: base + 1000 + i * 10 + 5,
        character: { name, realm: "Faerlina", clientVersion: "2.5.6", level: 21 },
      }));
    }
    // Older meaningful change on realm B — outside top-20 version-wide.
    store.importSnapshot(buildWowSyncExport({
      generatedAt: base,
      character: { name: "Quiet", realm: "Grobbulus", clientVersion: "2.5.6", level: 30 },
    }));
    store.importSnapshot(buildWowSyncExport({
      generatedAt: base + 5,
      character: { name: "Quiet", realm: "Grobbulus", clientVersion: "2.5.6", level: 31 },
    }));

    const capped = store.recentChanges("tbc-anniversary", 20);
    assert.equal(capped.length, 20);
    assert.equal(capped.some((c) => c.characterName === "Quiet"), false, "Quiet must fall outside version-wide top-20");

    const uncapped = store.recentChanges("tbc-anniversary");
    assert.equal(uncapped.some((c) => c.characterName === "Quiet"), true);

    const facts = store.buildAccountFacts("tbc-anniversary", base + 10_000);
    assert.equal(facts.recentChanges.some((c) => c.characterName === "Quiet"), true, "AccountFacts must carry Quiet for post-scope display");
    assert.ok(facts.recentChanges.length > 20);
  } finally {
    store.close();
  }
});

// --- Slice A: append-only Retail equipment observations (snapshot_equipment_observations) ---------------------
// Every test reads the actual table through a second raw connection: the outcome string alone proves nothing.

interface ObservationRow {
  id: number;
  character_id: number;
  snapshot_id: number;
  observed_at: number;
  capture: number;
  revision: number;
  completeness: string;
  evidence_json: string;
  stored_at: number;
}

/** A file-backed store plus a raw connection onto the same database. */
function observedStore() {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-equipment-"));
  const path = join(folder, "test.sqlite");
  const store = new SqliteSnapshotStore(path);
  const raw = new DatabaseSync(path);
  const rows = () => raw.prepare("SELECT * FROM snapshot_equipment_observations ORDER BY id").all() as unknown as ObservationRow[];
  const snapshots = () => raw.prepare("SELECT id, character_id, generated_at, raw_text, parsed_json FROM snapshots ORDER BY id").all() as unknown as Array<{ id: number; character_id: number; generated_at: number; raw_text: string; parsed_json: string }>;
  const characterId = (identityKey: string) => (raw.prepare("SELECT id FROM characters WHERE identity_key = ?").get(identityKey) as { id: number } | undefined)?.id;
  const h = {
    path,
    store,
    raw,
    rows,
    snapshots,
    characterId,
    cleanup() {
      raw.close();
      h.store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
  return h;
}
const evidence = (row: ObservationRow) => JSON.parse(row.evidence_json);
const activeSpec = (row: ObservationRow) => evidence(row).specEquipmentObservation?.activeSpecBefore?.specID;
const BM = { observedAt: 1791375064, capture: 29, revision: 220 };
const MM = { observedAt: 1791375400, capture: 3, revision: 220 };

test("A03 canonical sidecar with no projection is recorded as one row", () => {
  const h = observedStore();
  try {
    const result = h.store.importSnapshot(retailExport(), { equipmentObservation: observation() });
    assert.equal(result.equipmentObservation, "recorded");
    assert.equal(h.rows().length, 1);
    assert.equal(activeSpec(h.rows()[0]), 253);
  } finally {
    h.cleanup();
  }
});

test("A04 canonical sidecar with an equivalent latestExport projection is recorded", () => {
  const h = observedStore();
  try {
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ projection: true }) }).equipmentObservation, "recorded");
    assert.equal(h.rows().length, 1);
  } finally {
    h.cleanup();
  }
});

test("A05 a projection that disagrees with the canonical sidecar is projection-mismatch: no row, snapshot still imported", () => {
  const h = observedStore();
  try {
    const result = h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ projection: sidecar(BM, { stability: "UNSTABLE", afterSpecID: 254 }) }) });
    assert.equal(result.equipmentObservation, "projection-mismatch");
    assert.equal(result.isFirstSnapshot, true);
    assert.equal(h.snapshots().length, 1);
    assert.equal(h.rows().length, 0);
  } finally {
    h.cleanup();
  }
});

test("A06 a projection without a canonical sidecar (or without any envelope) is projection-without-canonical: no row", () => {
  const h = observedStore();
  try {
    const noSidecar = h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ withSidecar: false, projection: sidecar() }) });
    assert.equal(noSidecar.equipmentObservation, "projection-without-canonical");
    const noEnvelope = h.store.importSnapshot(retailExport("Virek", "Cairne", 1_791_376_000), { equipmentObservation: { projection: sidecar() } });
    assert.equal(noEnvelope.equipmentObservation, "projection-without-canonical");
    assert.equal(h.snapshots().length, 2, "both snapshots imported");
    assert.equal(h.rows().length, 0);
  } finally {
    h.cleanup();
  }
});

test("A07 A08 A09 A10 observed_at, capture, revision and completeness columns are the canonical envelope values", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ completeness: "partial" }) });
    const [row] = h.rows();
    assert.equal(row.observed_at, 1791375064, "A07");
    assert.equal(row.capture, 29, "A08");
    assert.equal(row.revision, 220, "A09");
    assert.equal(row.completeness, "partial", "A10");
    const ev = evidence(row);
    assert.deepEqual(Object.keys(ev).sort(), ["changedAt", "reason", "slots", "source", "specEquipmentObservation"], "columns are not duplicated into evidence_json");
    assert.equal(ev.reason, "Item metadata or equipped tooltip pending");
    assert.equal(ev.slots["16"].itemID, 237611, "equipment rows come from the envelope");
  } finally {
    h.cleanup();
  }
});

test("A19 the new-snapshot branch inserts a row tied to the new snapshot", () => {
  const h = observedStore();
  try {
    const result = h.store.importSnapshot(retailExport(), { equipmentObservation: observation() });
    const [row] = h.rows();
    assert.equal(result.isDuplicate, false);
    assert.equal(row.snapshot_id, result.snapshot.id);
    assert.equal(row.character_id, h.characterId("retail::cairne::virek"));
  } finally {
    h.cleanup();
  }
});

test("A20 the duplicate-snapshot branch inserts a distinct tuple; A21 one snapshot_id references several rows", () => {
  const h = observedStore();
  try {
    const first = h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ tuple: BM }) });
    const second = h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ tuple: { ...BM, observedAt: BM.observedAt + 5, capture: 30 } }) });
    assert.equal(second.isDuplicate, true, "A20: the text is a duplicate");
    assert.equal(second.equipmentObservation, "recorded", "A20");
    assert.equal(h.snapshots().length, 1);
    const rows = h.rows();
    assert.equal(rows.length, 2, "A20");
    assert.deepEqual(rows.map((r) => r.snapshot_id), [first.snapshot.id, first.snapshot.id], "A21: same arrival row, two observations");
  } finally {
    h.cleanup();
  }
});

test("A22 the exact same tuple and evidence again is already-recorded and adds no row", () => {
  const h = observedStore();
  try {
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: observation() }).equipmentObservation, "recorded");
    const before = h.rows();
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: observation() }).equipmentObservation, "already-recorded");
    assert.equal(h.store.importSnapshot(retailExport("Virek", "Cairne", 1_791_380_000), { equipmentObservation: observation() }).equipmentObservation, "already-recorded", "also from a new snapshot row");
    assert.deepEqual(h.rows(), before);
  } finally {
    h.cleanup();
  }
});

test("A23 the same tuple with contradictory evidence is a conflict: the first row is kept byte-for-byte and the import succeeds", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport(), { equipmentObservation: observation() });
    const before = h.rows();
    const contradictions = [
      observation({ completeness: "partial" }),
      observation({ specID: 254 }),
      observation({ slots: { "1": { itemID: 1 } } }),
    ];
    for (const contradiction of contradictions) {
      const result = h.store.importSnapshot(retailExport(), { equipmentObservation: contradiction });
      assert.equal(result.equipmentObservation, "conflict");
      assert.equal(result.isDuplicate, true, "the snapshot import itself still succeeds");
    }
    const newer = h.store.importSnapshot(retailExport("Virek", "Cairne", 1_791_390_000), { equipmentObservation: observation({ specID: 255 }) });
    assert.equal(newer.equipmentObservation, "conflict");
    assert.equal(newer.isDuplicate, false, "a new snapshot is still stored");
    assert.deepEqual(h.rows(), before);
  } finally {
    h.cleanup();
  }
});

test("A24 BM and MM observations arriving with IDENTICAL WOWSYNC text are both stored and independently retrievable", () => {
  const h = observedStore();
  try {
    const text = retailExport();
    const bm = h.store.importSnapshot(text, { equipmentObservation: observation({ tuple: BM, specID: 253, projection: true }) });
    const mm = h.store.importSnapshot(text, { equipmentObservation: observation({ tuple: MM, specID: 254, projection: true }) });
    assert.equal(bm.equipmentObservation, "recorded");
    assert.equal(mm.equipmentObservation, "recorded");
    assert.equal(mm.isDuplicate, true);
    assert.equal(mm.snapshot.id, bm.snapshot.id);
    const rows = h.rows();
    assert.equal(rows.length, 2);
    const bmRow = rows.find((r) => r.observed_at === BM.observedAt)!;
    const mmRow = rows.find((r) => r.observed_at === MM.observedAt)!;
    assert.equal(activeSpec(bmRow), 253);
    assert.equal(activeSpec(mmRow), 254);
    assert.deepEqual(evidence(bmRow).specEquipmentObservation.equipmentObservation, BM);
    assert.deepEqual(evidence(mmRow).specEquipmentObservation.equipmentObservation, MM);
    assert.equal(bmRow.snapshot_id, mmRow.snapshot_id, "snapshot_id is arrival provenance, not identity");
  } finally {
    h.cleanup();
  }
});

test("A25 equipment observations never enter parsed_json or characterState", () => {
  const h = observedStore();
  try {
    const result = h.store.importSnapshot(retailExport(), { equipmentObservation: observation(), characterState: { formatVersion: 1, clientFamily: "Retail", combatSpecialization: combatDomain(253) } });
    assert.equal(result.characterState, "recorded");
    for (const s of h.snapshots()) {
      assert.doesNotMatch(s.parsed_json, /specEquipmentObservation|equipmentObservation|1791375064/);
    }
    assert.deepEqual(Object.keys(result.snapshot.parsed.characterState ?? {}).sort(), ["clientFamily", "combatSpecialization", "formatVersion"]);
  } finally {
    h.cleanup();
  }
});

test("A26 a newer snapshot without the field copies no observation forward and marks nothing LAST_SEEN", () => {
  const h = observedStore();
  try {
    const state = { formatVersion: 1, clientFamily: "Retail", combatSpecialization: combatDomain(255) };
    const first = h.store.importSnapshot(retailExport("Virek", "Cairne", 1_791_375_000), { equipmentObservation: observation({ specID: 255 }), characterState: state });
    const later = h.store.importSnapshot(retailExport("Virek", "Cairne", 1_791_475_000));
    assert.equal(later.isLatest, true);
    assert.equal(later.equipmentObservation, undefined);
    const rows = h.rows();
    assert.equal(rows.length, 1, "no copied row");
    assert.equal(rows[0].snapshot_id, first.snapshot.id);
    assert.doesNotMatch(rows[0].evidence_json, /LAST_SEEN/);
    const laterJson = h.snapshots().find((s) => s.id === later.snapshot.id)!.parsed_json;
    assert.match(laterJson, /LAST_SEEN/, "the existing characterState domain is still carried forward as before");
    assert.doesNotMatch(laterJson, /specEquipmentObservation|equipmentObservation/);
  } finally {
    h.cleanup();
  }
});

test("A28 snapshot text dedupe is unchanged: same text and Generated is one snapshot whatever observations ride along", () => {
  const h = observedStore();
  try {
    const text = retailExport();
    const a = h.store.importSnapshot(text, { equipmentObservation: observation({ tuple: BM }) });
    const b = h.store.importSnapshot(text, { equipmentObservation: observation({ tuple: MM }) });
    const c = h.store.importSnapshot(text);
    assert.deepEqual([a.isDuplicate, b.isDuplicate, c.isDuplicate], [false, true, true]);
    assert.equal(h.snapshots().length, 1);
    assert.equal(h.store.listSnapshots("retail::cairne::virek").length, 1);
  } finally {
    h.cleanup();
  }
});

test("A30 rows belong to the Retail version::realm::name character; same name on another realm and other characters stay separate", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport("Virek", "Cairne"), { equipmentObservation: observation() });
    h.store.importSnapshot(retailExport("Virek", "Area 52"), { equipmentObservation: observation() });
    h.store.importSnapshot(retailExport("Ciao", "Cairne"), { equipmentObservation: observation() });
    const rows = h.rows();
    assert.equal(rows.length, 3, "the same tuple is a separate observation per character");
    assert.deepEqual(
      rows.map((r) => r.character_id).sort(),
      ["retail::cairne::virek", "retail::area 52::virek", "retail::cairne::ciao"].map((key) => h.characterId(key)!).sort(),
    );
  } finally {
    h.cleanup();
  }
});

test("A31 Classic Era, TBC and Forever exports carrying the field are invalid-or-unsupported and store nothing; so is a non-Retail sidecar", () => {
  const h = observedStore();
  try {
    const exports = [
      buildWowSyncExport({ character: { name: "Bromrik", realm: "Defias Pillager", clientVersion: "1.15.7" } }),
      buildWowSyncExport({ character: { name: "Voodan", realm: "Dreamscythe", clientVersion: "2.5.4" } }),
      buildWowSyncExport({ character: { name: "Hallo", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.15.8" } }),
    ];
    for (const text of exports) {
      const result = h.store.importSnapshot(text, { equipmentObservation: observation({ projection: true }) });
      assert.equal(result.equipmentObservation, "invalid-or-unsupported", result.character.version);
      assert.notEqual(result.character.version, "retail");
    }
    const classicSidecar = observation();
    (classicSidecar.envelope.specEquipmentObservation as any).clientFamily = "Classic";
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: classicSidecar }).equipmentObservation, "invalid-or-unsupported");
    assert.equal(h.rows().length, 0);
    assert.equal(h.snapshots().length, 4, "every snapshot is still imported");
  } finally {
    h.cleanup();
  }
});

test("A33 A34 A35 structurally valid partial, UNSTABLE and NOT_READY observations are stored as evidence", () => {
  const h = observedStore();
  try {
    const cases = [
      ["A33 partial", observation({ tuple: { ...BM, observedAt: 1 }, completeness: "partial" })],
      ["A34 UNSTABLE", observation({ tuple: { ...BM, observedAt: 2 }, specID: 253, afterSpecID: 254 })],
      ["A35 NOT_READY", observation({ tuple: { ...BM, observedAt: 3 }, readiness: "NOT_READY" })],
      ["UNKNOWN", observation({ tuple: { ...BM, observedAt: 4 }, readiness: "UNKNOWN" })],
    ] as const;
    for (const [label, input] of cases) assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: input }).equipmentObservation, "recorded", label);
    const rows = h.rows();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].completeness, "partial");
    assert.equal(evidence(rows[1]).specEquipmentObservation.stability, "UNSTABLE");
    assert.equal(evidence(rows[2]).specEquipmentObservation.stability, "NOT_READY");
    assert.deepEqual(evidence(rows[2]).specEquipmentObservation.activeSpecBefore, {});
    assert.equal(evidence(rows[3]).specEquipmentObservation.readiness, "UNKNOWN");
  } finally {
    h.cleanup();
  }
});

test("A36 opening a database from before Slice A adds the empty table and leaves existing rows untouched (no backfill)", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport(), { characterState: { formatVersion: 1, clientFamily: "Retail", combatSpecialization: combatDomain(253) } });
    h.store.importSnapshot(retailExport("Ciao", "Cairne"));
    h.raw.exec("DROP TABLE snapshot_equipment_observations");
    const before = h.snapshots();
    const characters = h.raw.prepare("SELECT * FROM characters ORDER BY id").all();
    h.store.close();
    const reopened = new SqliteSnapshotStore(h.path);
    try {
      assert.equal(h.rows().length, 0, "created empty");
      assert.deepEqual(h.snapshots(), before);
      assert.deepEqual(h.raw.prepare("SELECT * FROM characters ORDER BY id").all(), characters);
    } finally {
      reopened.close();
    }
    h.store = new SqliteSnapshotStore(h.path);
  } finally {
    h.cleanup();
  }
});

test("A37 schema creation is idempotent: reopening keeps one table and its rows", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport(), { equipmentObservation: observation() });
    const rows = h.rows();
    for (let i = 0; i < 2; i++) new SqliteSnapshotStore(h.path).close();
    assert.deepEqual(h.rows(), rows);
    const tables = h.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_equipment_observations'").get() as { n: number };
    assert.equal(Number(tables.n), 1);
    const sql = (h.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'snapshot_equipment_observations'").get() as { sql: string }).sql;
    assert.match(sql, /UNIQUE \(character_id, observed_at, capture, revision\)/);
    assert.match(sql, /CHECK \(completeness IN \('complete', 'partial'\)\)/);
  } finally {
    h.cleanup();
  }
});

test("A41 a re-import whose envelope gained S.Attempt diagnostics is already-recorded, and they are never stored", () => {
  const h = observedStore();
  try {
    h.store.importSnapshot(retailExport(), { equipmentObservation: observation() });
    const result = h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ lastAttempt: true }) });
    assert.equal(result.equipmentObservation, "already-recorded");
    assert.equal(h.rows().length, 1);
    assert.doesNotMatch(h.rows()[0].evidence_json, /lastAttempt/);
  } finally {
    h.cleanup();
  }
});

test("A42 a sidecar-less Retail envelope is stored as evidence without specEquipmentObservation (policy E)", () => {
  const h = observedStore();
  try {
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ withSidecar: false }) }).equipmentObservation, "recorded");
    const [row] = h.rows();
    assert.equal("specEquipmentObservation" in evidence(row), false);
    assert.equal(evidence(row).slots["1"].itemID, 237610);
  } finally {
    h.cleanup();
  }
});

test("A43 a structurally valid sidecar whose link tuple disagrees with the envelope is stored verbatim (nonqualifying), not rejected", () => {
  const h = observedStore();
  try {
    const link = { observedAt: BM.observedAt, capture: BM.capture, revision: 219 };
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: observation({ link }) }).equipmentObservation, "recorded");
    const [row] = h.rows();
    assert.equal(row.revision, 220, "the columns are the envelope's");
    assert.deepEqual(evidence(row).specEquipmentObservation.equipmentObservation, link, "the link is kept as GearExport wrote it");
    const odd = observation({ tuple: { ...BM, observedAt: 7 }, link: { observedAt: "x", capture: null, revision: 1.5 } });
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: odd }).equipmentObservation, "recorded");
  } finally {
    h.cleanup();
  }
});

test("A44 the same evidence with a different key order is already-recorded, not a conflict", () => {
  const h = observedStore();
  try {
    const input = observation();
    h.store.importSnapshot(retailExport(), { equipmentObservation: input });
    const reorder = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
    assert.equal(h.store.importSnapshot(retailExport(), { equipmentObservation: reorder(input) }).equipmentObservation, "already-recorded");
    assert.equal(h.rows().length, 1);
  } finally {
    h.cleanup();
  }
});

test("A38 the Retail recipient screen answers identically whether or not exporter and recipient carry equipment observations", () => {
  const NOW = 1_800_000_000;
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const row = (requiredLevel: string, subclass = "4") => ["EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123", "?", "1", "0", requiredLevel, "4", subclass, "INVTYPE_HEAD", "no", "?", "yes", "no", "?", "0", "yes", "OBSERVED"].join("\t");
  const exporterText = buildWowSyncExport({ generatedAt: NOW - 30, character: { name: "Exporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } })
    .replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${NOW - 30}\nContractVersion: 1\n${header}\n${[row("91"), row("90"), row("1", "1")].join("\n")}\n\n[END]`);
  const recipientText = buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } });
  const screen = (withObservation: boolean) => {
    const store = new SqliteSnapshotStore(":memory:");
    const wallClock = Date.now;
    try {
      // Imported-at timestamps are incidental to this contract comparison. Keep
      // the fixture deterministic even when the two stores straddle a second.
      Date.now = () => NOW * 1000;
      store.importSnapshot(exporterText, withObservation ? { equipmentObservation: observation({ tuple: { observedAt: NOW - 30, capture: 1, revision: 1 } }) } : {});
      store.importSnapshot(recipientText, withObservation ? { equipmentObservation: observation({ tuple: { observedAt: NOW - 5, capture: 2, revision: 1 }, specID: 255 }) } : {});
      return new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Virek", recipientRealm: "Cairne", offset: 0, limit: 10 });
    } finally {
      Date.now = wallClock;
      store.close();
    }
  };
  const plain = screen(false);
  assert.equal(plain.status, "FOUND");
  assert.deepEqual(screen(true), plain);
  assert.doesNotMatch(JSON.stringify(plain), /specEquipmentObservation|equipmentObservation/);
});
