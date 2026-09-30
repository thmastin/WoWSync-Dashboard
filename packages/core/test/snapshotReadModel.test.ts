import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_700_000_000;
const key = "retail::cairne::historian";

function snapshot(options: {
  at: number; level?: number; gold?: number; played?: number; xp?: number;
  location?: string; equipment?: number; bank?: "observed" | "last-seen" | "unknown";
  bags?: "observed" | "unknown"; bagQty?: number; profession?: "observed" | "unknown"; skill?: number;
}) {
  const equipmentUnknown = options.equipment === undefined;
  const bankState = options.bank ?? "observed";
  const bagsState = options.bags ?? "observed";
  const professionState = options.profession ?? "observed";
  const currencies = options.at === NOW - 400 ? [{ currencyID: 100, name: "Test Token", quantity: 0, isAccountWide: false }] : options.at === NOW - 300 ? [{ currencyID: 100, name: "Test Token", quantity: 7, isAccountWide: false }, { currencyID: 101, name: "New Token", quantity: 2, isAccountWide: false }] : undefined;
  return {
    text: buildWowSyncExport({
      generatedAt: options.at,
      character: { name: "Historian", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: options.level, moneyCopper: options.gold, playedSeconds: options.played, xp: options.xp, xpMax: 100 },
      location: { zone: options.location ?? "Elwynn Forest" },
      equipment: equipmentUnknown ? { unknown: true } : { slots: [{ slot: 1, slotName: "Head", itemRef: `item:${options.equipment}`, name: `Helm ${options.equipment}` }] },
      bags: bagsState === "unknown" ? { unknown: true } : { containers: [{ id: 0, capacity: 20, free: 19, items: [{ itemRef: "item:500", name: "Test Herb", qty: options.bagQty ?? 2 }] }] },
      bank: bankState === "unknown" ? { unknown: true } : { lastSeen: bankState === "last-seen", containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:600", name: "Bank Item", qty: options.at === NOW - 400 ? 5 : 3 }] }] },
      professions: professionState === "unknown" ? { unknown: true } : { entries: [{ name: "Alchemy", skill: options.skill ?? 10, maxSkill: 100 }, ...(options.at === NOW - 300 || options.at === NOW - 100 ? [{ name: "Mining", skill: 1, maxSkill: 100 }] : [])], retail: true },
    }),
    extras: currencies ? { currencies: { observedAt: options.at, data: { listRead: true, formatVersion: 1, currencies } } } : undefined,
  };
}

test("history is newest-first, paged, compact, version and identity scoped", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (let index = 0; index < 4; index++) {
      const built = snapshot({ at: NOW - 400 + index * 100, level: 10 + index, bank: index === 2 ? "last-seen" : index === 3 ? "unknown" : "observed" });
      store.importSnapshot(built.text, built.extras);
    }
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 1, character: { name: "Historian", realm: "Thrall", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 1, character: { name: "Historian", realm: "Cairne", clientVersion: "1.15.9" } }));
    const read = new DashboardReadModel(store, () => NOW);
    const firstPage = read.getCharacterSnapshotHistory({ version: "retail", name: "Historian", realm: "Cairne", limit: 2 });
    assert.equal(firstPage.status, "FOUND");
    if (firstPage.status !== "FOUND") return;
    assert.deepEqual(firstPage.value.data?.items.map((entry) => entry.level), [13, 12]);
    assert.equal(firstPage.value.data?.totalCount, 4);
    assert.equal(firstPage.value.data?.truncated, true);
    assert.ok(firstPage.value.data?.items[0]?.observedAt! > firstPage.value.data?.items[1]?.observedAt!);
    assert.equal(firstPage.value.data?.items[0]?.bankState, "UNKNOWN");
    assert.equal("parsed" in firstPage.value.data!.items[0]!, false);
    const secondPage = read.getCharacterSnapshotHistory({ version: "retail", name: "Historian", realm: "Cairne", offset: 2, limit: 2 });
    assert.equal(secondPage.status, "FOUND");
    if (secondPage.status === "FOUND") {
      assert.deepEqual(secondPage.value.data?.items.map((entry) => entry.level), [11, 10]);
      assert.equal(secondPage.value.data?.truncated, false);
    }
    const classicHistory = read.getCharacterSnapshotHistory({ version: "classic-era", name: "Historian", realm: "Cairne" });
    assert.equal(classicHistory.status, "FOUND");
    if (classicHistory.status === "FOUND") assert.equal(classicHistory.value.data?.totalCount, 1);
    assert.equal(read.getCharacterSnapshotHistory({ version: "retail", name: "Historian" }).status, "AMBIGUOUS");
  } finally { store.close(); }
});

test("semantic snapshot changes reuse typed diff logic and gate UNKNOWN/LAST_SEEN sections", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const older = snapshot({ at: NOW - 400, level: 10, gold: 0, played: 100, xp: 10, location: "Elwynn Forest", equipment: 100, bagQty: 2, skill: 10 });
    const newer = snapshot({ at: NOW - 300, level: 11, gold: 500, played: 200, xp: 20, location: "Westfall", equipment: 200, bagQty: 5, skill: 20 });
    const historicalBank = snapshot({ at: NOW - 200, level: 12, bank: "last-seen", bags: "unknown", profession: "unknown" });
    const unknownLater = snapshot({ at: NOW - 100, level: 13, bank: "unknown", bags: "unknown", profession: "unknown", equipment: undefined });
    const a = store.importSnapshot(older.text, older.extras);
    const b = store.importSnapshot(newer.text, newer.extras);
    const c = store.importSnapshot(historicalBank.text, historicalBank.extras);
    const d = store.importSnapshot(unknownLater.text, unknownLater.extras);
    const foreign = store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 50, character: { name: "Other", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 50, character: { name: "Historian", realm: "Cairne", clientVersion: "1.15.9" } }));
    const read = new DashboardReadModel(store, () => NOW);

    const latest = read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne" });
    assert.equal(latest.status, "FOUND");
    if (latest.status === "FOUND") {
      assert.equal(latest.value.data?.fromSnapshot?.snapshotId, c.snapshot.id);
      assert.equal(latest.value.data?.toSnapshot?.snapshotId, d.snapshot.id);
      assert.equal(latest.value.data?.changes?.economy.goldCopper.state, "UNKNOWN");
      assert.equal(latest.value.data?.changes?.bank.state, "LAST_SEEN");
      assert.deepEqual(latest.value.data?.changes?.bank.itemChanges.items, []);
      assert.equal(latest.value.data?.changes?.bags.state, "UNKNOWN");
      assert.equal(latest.value.data?.changes?.professions.state, "UNKNOWN");
    }

    const observedPair = read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne", fromSnapshotId: a.snapshot.id, toSnapshotId: b.snapshot.id });
    assert.equal(observedPair.status, "FOUND");
    if (observedPair.status === "FOUND") {
      const changes = observedPair.value.data!.changes!;
      assert.equal(changes.economy.goldCopper.state, "COMPARED");
      assert.equal(changes.economy.goldCopper.from, 0);
      assert.equal(changes.economy.goldCopper.delta, 500);
      assert.equal(changes.progression.level.delta, 1);
      assert.equal(changes.progression.location.changed, true);
      assert.equal(changes.equipment.changes.items[0]?.from, "item:100");
      assert.equal(changes.bags.itemChanges.items[0]?.deltaQty, 3);
      assert.equal(changes.bank.state, "COMPARED");
      assert.equal(changes.bank.itemChanges.items[0]?.deltaQty, -2);
      assert.equal(changes.professions.changes.items.some((entry) => entry.name === "Alchemy" && entry.skill.delta === 10), true);
      assert.equal(changes.professions.changes.items.some((entry) => entry.name === "Mining"), true);
      assert.equal(changes.currencies.state, "PARTIAL");
      assert.deepEqual(changes.currencies.changes.items.map((entry) => [entry.currencyID, entry.scope, entry.fromQuantity, entry.toQuantity]), [[100, "CHARACTER", 0, 7]]);
    }

    const lastSeenPair = read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne", fromSnapshotId: b.snapshot.id, toSnapshotId: c.snapshot.id });
    assert.equal(lastSeenPair.status, "FOUND");
    if (lastSeenPair.status === "FOUND") {
      assert.equal(lastSeenPair.value.data?.changes?.bank.state, "LAST_SEEN");
      assert.deepEqual(lastSeenPair.value.data?.changes?.bank.itemChanges.items, []);
    }
    const unknownPair = read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne", fromSnapshotId: b.snapshot.id, toSnapshotId: d.snapshot.id });
    assert.equal(unknownPair.status, "FOUND");
    if (unknownPair.status === "FOUND") {
      assert.equal(unknownPair.value.data?.changes?.bank.state, "UNKNOWN");
      assert.equal(unknownPair.value.data?.changes?.equipment.state, "UNKNOWN");
      assert.equal(unknownPair.value.data?.changes?.currencies.state, "UNKNOWN");
      assert.deepEqual(unknownPair.value.data?.changes?.currencies.changes.items, []);
    }
    assert.throws(() => read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne", fromSnapshotId: a.snapshot.id }), /supplied together/);
    assert.throws(() => read.getCharacterChanges({ version: "retail", name: "Historian", realm: "Cairne", fromSnapshotId: a.snapshot.id, toSnapshotId: foreign.snapshot.id }), /belong to the resolved character/);
    assert.throws(() => read.getCharacterChanges({ version: "classic-era", name: "Historian", realm: "Cairne", fromSnapshotId: a.snapshot.id, toSnapshotId: d.snapshot.id }), /belong to the resolved character/);
  } finally { store.close(); }
});

test("snapshot history clamps oversized limits and reports truncation instead of silently dropping entries", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (let index = 0; index < 105; index++) {
      store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 1000 + index, character: { name: "Many", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: index } }));
    }
    const result = new DashboardReadModel(store, () => NOW).getCharacterSnapshotHistory({ version: "retail", name: "Many", realm: "Cairne", limit: 1000 });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data?.items.length, 100);
      assert.equal(result.value.data?.totalCount, 105);
      assert.equal(result.value.data?.truncated, true);
    }
  } finally { store.close(); }
});

test("semantic delta lists report returned and total counts when bounded", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const make = (at: number, prefix: string, skill: number) => buildWowSyncExport({
      generatedAt: at,
      character: { name: "Bounded", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 80 },
      bags: { containers: [{ id: 0, capacity: 100, free: 0, items: Array.from({ length: 30 }, (_, index) => ({ itemRef: `item:${prefix}${index}`, name: `${prefix}${index}`, qty: 1 })) }] },
      professions: { entries: Array.from({ length: 25 }, (_, index) => ({ name: `Profession ${index}`, skill: skill + index, maxSkill: 100 })), retail: true },
    });
    const from = store.importSnapshot(make(NOW - 10, "A", 10));
    const to = store.importSnapshot(make(NOW - 5, "B", 20));
    const result = new DashboardReadModel(store, () => NOW).getCharacterChanges({ version: "retail", name: "Bounded", realm: "Cairne", fromSnapshotId: from.snapshot.id, toSnapshotId: to.snapshot.id });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      const changes = result.value.data?.changes;
      assert.equal(changes?.bags.itemChanges.totalCount, 60);
      assert.equal(changes?.bags.itemChanges.returnedCount, 25);
      assert.equal(changes?.bags.itemChanges.truncated, true);
      assert.equal(changes?.professions.changes.totalCount, 25);
      assert.equal(changes?.professions.changes.returnedCount, 20);
      assert.equal(changes?.professions.changes.truncated, true);
    }
  } finally { store.close(); }
});
