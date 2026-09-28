import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_800_000_000;
function retail(name: string, realm: string, moneyCopper?: number) {
  return buildWowSyncExport({ generatedAt: NOW - 10, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper }, equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: "item:1", name: "Observed Helm", itemLevel: 279 }] } });
}
function classic(name: string, realm: string) { return buildWowSyncExport({ generatedAt: NOW - 20, character: { name, realm, clientVersion: "1.15.9" } }); }

test("read model requires a version and cannot leak a same-named Classic character into Retail", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(classic("Twin", "Era"));
    store.importSnapshot(retail("Twin", "Cairne", 0));
    const read = new DashboardReadModel(store, () => NOW);
    assert.throws(() => read.listCharacters({ version: undefined as never }), /version is required/);
    const result = read.getCharacterSummary({ version: "retail", name: "Twin", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data?.realm, "Cairne");
      assert.equal(result.value.data?.goldCopper, 0, "observed zero remains a real zero");
      assert.equal(result.value.provenance.version, "retail");
    }
  } finally { store.close(); }
});

test("same-name realm matches are ambiguity, never a silent choice", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Twin", "Cairne"));
    store.importSnapshot(retail("Twin", "Thrall"));
    const result = new DashboardReadModel(store, () => NOW).getCharacterEquipment({ version: "retail", name: "Twin" });
    assert.equal(result.status, "AMBIGUOUS");
    if (result.status === "AMBIGUOUS") assert.deepEqual(result.candidates.map((entry) => entry.realm).sort(), ["Cairne", "Thrall"]);
  } finally { store.close(); }
});

test("unknown sections remain UNKNOWN rather than empty and profession coverage is DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "Era", clientVersion: "1.15.9" }, equipment: { unknown: true }, professions: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const equipment = read.getCharacterEquipment({ version: "classic-era", name: "Ghost", realm: "Era" });
    assert.equal(equipment.status, "FOUND");
    if (equipment.status === "FOUND") {
      assert.equal(equipment.value.provenance.state, "UNKNOWN");
      assert.equal(equipment.value.data, undefined);
    }
    const coverage = read.getProfessionCoverage({ version: "classic-era" });
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.data?.coverage.every((entry) => entry.coverageStatus === "unknown"));
  } finally { store.close(); }
});

test("LAST_SEEN section provenance is retained as historical, never current", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Historian", realm: "Era", clientVersion: "1.15.9" }, professions: { entries: [{ name: "Alchemy", skill: 1, maxSkill: 300 }] } }));
    const originalListSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => ({ ...snapshot, parsed: { ...snapshot.parsed, professions: { ...snapshot.parsed.professions, status: { ...snapshot.parsed.professions.status, state: "LAST_SEEN" } } } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterProfessions({ version: "classic-era", name: "Historian", realm: "Era" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "LAST_SEEN");
      assert.match(result.value.provenance.warning ?? "", /historical/i);
    }
  } finally { store.close(); }
});

test("snapshot history is compact metadata and never leaks raw export text", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Archivist", "Cairne", 123));
    const result = new DashboardReadModel(store, () => NOW).getCharacterSnapshotHistory({ version: "retail", name: "Archivist", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      const history = result.value.data;
      assert.equal(result.value.provenance.state, "OBSERVED");
      assert.equal(history?.[0]?.moneyCopper, 123);
      assert.equal("parsed" in (history?.[0] ?? {}), false);
      assert.equal("raw" in (history?.[0] ?? {}), false);
    }
  } finally { store.close(); }
});

test("shared storage stays Retail-only and its projection is explicitly DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const read = new DashboardReadModel(store, () => NOW);
    assert.equal(read.getSharedStorage({ version: "classic-era" }).provenance.state, "UNKNOWN");
    const retailStorage = read.getSharedStorage({ version: "retail" });
    assert.equal(retailStorage.provenance.state, "DERIVED");
    assert.equal(retailStorage.data?.warband, null);
    assert.deepEqual(retailStorage.data?.guilds, []);
  } finally { store.close(); }
});

test("uncaptured Renown is explicitly UNKNOWN and separate from research", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Virek", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getRenown({ version: "retail", name: "Virek", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "UNKNOWN");
      assert.match(result.value.provenance.reason ?? "", /does not currently capture Renown/);
    }
  } finally { store.close(); }
});
