import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "Era", clientVersion: "1.15.9" }, equipment: { unknown: true }, bags: { unknown: true }, professions: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const equipment = read.getCharacterEquipment({ version: "classic-era", name: "Ghost", realm: "Era" });
    assert.equal(equipment.status, "FOUND");
    if (equipment.status === "FOUND") {
      assert.equal(equipment.value.provenance.state, "UNKNOWN");
      assert.equal(equipment.value.data, undefined);
    }
    const bags = read.getCharacterStorage({ version: "classic-era", name: "Ghost", realm: "Era", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.data?.sectionState, "UNKNOWN");
      assert.equal(bags.value.data?.itemsKnownEmpty, false);
      assert.equal(bags.value.data?.items, undefined);
    }
    const coverage = read.getProfessionCoverage({ version: "classic-era" });
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.data?.coverage.every((entry) => entry.coverageStatus === "unknown"));
  } finally { store.close(); }
});

test("observed-empty character storage remains distinct from UNKNOWN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Empty", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [] } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterStorage({ version: "retail", name: "Empty", realm: "Cairne", storage: "bags" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "OBSERVED");
      assert.equal(result.value.data?.itemsKnownEmpty, true);
      assert.deepEqual(result.value.data?.items, []);
    }
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

test("gear candidate read preserves per-character snapshot provenance, row state, captured-empty and missing sidecars", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const append = (raw: string, body: string) => raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\n${body}\n\n[END]`);
    const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
    const raw = append(retail("Evidence", "Cairne"), `State: partial; observed=${NOW - 20}\nContractVersion: 1\n${header}\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t0\t0\t0\t4\t0\tINVTYPE_HEAD\tno\t?\tyes\tno\t?\t9\tno\tLAST_SEEN`);
    store.importSnapshot(raw);
    // Newer export lacks the optional sidecar; the latest captured sidecar remains explicitly historical.
    store.importSnapshot(retail("Evidence", "Cairne").replace("Generated: 1800000000", `Generated: ${NOW - 10}`));
    store.importSnapshot(retail("NoEvidence", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" });
    assert.equal(result.provenance.state, "DERIVED");
    const evidence = result.data?.characters.find((entry) => entry.identity.name === "Evidence")!;
    assert.equal(evidence.captured, true);
    assert.equal(evidence.identity.identityKey, "retail::cairne::evidence");
    assert.equal(evidence.snapshot?.snapshotId, store.listSnapshots(evidence.identity.identityKey)[1]?.id);
    assert.equal(evidence.snapshot?.freshness, "stale", "snapshot freshness is computed separately from the row evidence state");
    assert.equal(evidence.snapshot?.candidateObservedAt, NOW - 20);
    assert.equal(evidence.snapshot?.candidateFreshness, "recent", "sidecar observation age is computed independently of snapshot import timing");
    assert.equal(evidence.sidecar?.rows[0]?.observationState, "LAST_SEEN");
    assert.equal(evidence.sidecar?.observedAt, NOW - 20);
    assert.deepEqual(evidence.sidecar?.rows[0]?.currentCharacterCanUse, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.isBound, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.boundToAccountUntilEquip, { state: "UNKNOWN" });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccount, { state: "KNOWN", value: true });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccountUntilEquip, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.tooltipBindingRawValue, { state: "KNOWN", value: 9 });
    const unavailable = result.data?.characters.find((entry) => entry.identity.name === "NoEvidence")!;
    assert.equal(unavailable.captured, false);
    assert.equal(unavailable.sidecar, undefined);
    const empty = append(retail("EmptyEvidence", "Cairne"), `State: complete; observed=0\nContractVersion: 1\n${header}\nCandidates: None observed`);
    store.importSnapshot(empty);
    const emptyResult = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" }).data?.characters.find((entry) => entry.identity.name === "EmptyEvidence");
    assert.equal(emptyResult?.captured, true);
    assert.deepEqual(emptyResult?.sidecar?.rows, []);
    assert.equal(new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "classic-era" }).provenance.state, "UNKNOWN");
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
      assert.equal(result.value.provenance.state, "DERIVED");
      assert.equal(history?.items[0]?.moneyCopper, 123);
      assert.equal("parsed" in (history?.items[0] ?? {}), false);
      assert.equal("raw" in (history?.items[0] ?? {}), false);
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

test("bounded item and character-storage reads preserve version, section state, and metadata evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const captured = buildWowSyncExport({
      generatedAt: NOW - 10,
      character: { name: "Squashpot", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      bags: { containers: [{ id: 0, capacity: 20, free: 18, items: [{ itemRef: "item:12345", name: "Midnight Thread", qty: 2 }] }] },
      bank: { containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:23456", name: "Moonlit Hide", qty: 1 }] }] },
    }) .replace(/\n\[END\]$/, "") + "\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n12345\t7\t5\t1\t11\tyes\n\n[END]";
    store.importSnapshot(captured);
    store.importSnapshot(buildWowSyncExport({ character: { name: "Squashpot", realm: "Era", clientVersion: "1.15.9" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:12345", name: "Old Thread", qty: 7 }] }] } }));
    const read = new DashboardReadModel(store, () => NOW);
    const bags = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.provenance.state, "OBSERVED");
      assert.equal(bags.value.data?.items?.[0]?.name, "Midnight Thread");
      assert.equal(bags.value.data?.metadata[0]?.state, "KNOWN");
      assert.equal(bags.value.data?.metadata[0]?.value?.expansion.state, "KNOWN");
    }
    const bank = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bank" });
    assert.equal(bank.status, "FOUND");
    if (bank.status === "FOUND") assert.equal(bank.value.data?.items?.[0]?.name, "Moonlit Hide");
    const retailSearch = read.searchItems({ version: "retail", query: "thread", limit: 1 });
    assert.equal(retailSearch.data?.items[0]?.item.name, "Midnight Thread");
    assert.equal(retailSearch.provenance.version, "retail");
    assert.equal(read.searchItems({ version: "classic-era", query: "thread" }).data?.items[0]?.item.name, "Old Thread");
    assert.deepEqual(read.getItemMetadata({ version: "retail", itemIds: [12345, 99999] }).data?.map((item) => item.state), ["KNOWN", "UNKNOWN"]);
    assert.throws(() => read.searchItems({ version: "retail", query: "thread", offset: -1 }), /offset/);
  } finally { store.close(); }
});

test("shared storage read slices preserve owner and historical carrier semantics", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const fixture = new URL("./fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(fixture, "utf8"));
    const read = new DashboardReadModel(store, () => NOW);
    const warband = read.getSharedStorageContents({ version: "retail", kind: "warband", limit: 2 });
    assert.equal(warband.provenance.state, "DERIVED");
    assert.equal(warband.data?.owners[0]?.owner.kind, "warband");
    assert.ok(warband.data?.owners[0]?.current?.content.truncated);
    assert.equal(warband.data?.owners[0]?.current?.liveAtExport, false);
    const guildFixture = new URL("./fixtures/derived/ezaller-shared-storage-1789478317.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(guildFixture, "utf8"));
    const guild = read.getSharedStorageContents({ version: "retail", kind: "guild", limit: 1 });
    assert.equal(guild.data?.owners[0]?.owner.kind, "guild");
    if (guild.data?.owners[0]?.owner.kind === "guild") {
      assert.equal(typeof guild.data.owners[0].owner.guildClubId, "string");
      assert.deepEqual(guild.data.owners[0].current?.coverage.inaccessibleTabs, [3]);
      assert.equal(guild.data.owners[0].current?.provenance.sources[0]?.carrierState, "OBSERVED");
    }
    assert.equal(read.getSharedStorageContents({ version: "classic-era", kind: "warband" }).provenance.state, "UNKNOWN");
  } finally { store.close(); }
});
