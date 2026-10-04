// Dashboard Allocation tab milestone — the two read-model additions, end to end against a real
// SqliteSnapshotStore: (A) the demanded-page `itemNames` presentation sidecar, and (B) the unallocated search
// `q`. Neither may change Slice 1–3 semantics: demanded entries must still deep-equal getItemAllocation, and
// the whole-list counts keep their whole-account meaning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel, type AccountAllocationReview } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { filterUnallocatedByQuery, itemNameForItem } from "../src/allocationReview.ts";
import { projectAccountOwnedEvidenceMap } from "../src/allocation.ts";
import { renderExport, type ExportSpec } from "./sharedStorageExports.ts";
import { T, guildSection, observedSection, row, warbandSection } from "./allocationFixtures.ts";

function withFixture(run: (store: SqliteSnapshotStore, readModel: DashboardReadModel, imp: (spec: ExportSpec) => void) => void): void {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    run(store, new DashboardReadModel(store, () => T + 100), (spec) => void store.importSnapshot(renderExport(spec)));
  } finally {
    store.close();
  }
}

function review(readModel: DashboardReadModel, extra: Partial<Parameters<DashboardReadModel["getAllocationReview"]>[0]> = {}): AccountAllocationReview {
  const read = readModel.getAllocationReview({ version: "retail", demandedLimit: 100, unallocatedLimit: 100, ...extra });
  assert.equal(read.provenance.state, "DERIVED");
  assert.ok(!("itemNames" in read.provenance), "the name sidecar is data, never provenance");
  return read.data!;
}

const ids = (data: AccountAllocationReview) => data.unallocated.items.map((e) => e.baseItemId);

// --- A. demanded itemNames sidecar ------------------------------------------------------------------------------

test("itemNames covers exactly the demanded page, from account-owned evidence names", () => {
  withFixture((store, readModel, imp) => {
    imp({ name: "Anchor", generated: T, bags: observedSection([row(910001, 5, { name: "Dreamleaf" }), row(910002, 50, { name: "Mycobloom" }), row(910003, 1, { name: "Loose Item" })]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: 910001, requiredQuantity: 20 }); // short -> HOLD_ALLOCATED, ordered first
    store.createDemand({ baseItemId: 910002, requiredQuantity: 10 }); // surplus -> SEND_HELLOMAGS
    const full = review(readModel);
    assert.deepEqual(full.itemNames, { 910001: "Dreamleaf", 910002: "Mycobloom" });
    assert.ok(!(910003 in full.itemNames), "unallocated items are not in the demanded sidecar (they carry their own observed name)");
    const firstPage = review(readModel, { demandedLimit: 1 });
    assert.deepEqual(firstPage.demanded.items.map((r) => r.commodity.baseItemId), [910001]);
    assert.deepEqual(firstPage.itemNames, { 910001: "Dreamleaf" }, "attached after paging: only the page's items");
    const secondPage = review(readModel, { demandedOffset: 1, demandedLimit: 1 });
    assert.deepEqual(secondPage.itemNames, { 910002: "Mycobloom" });
  });
});

test("itemNames: a Warband-only item is named; an item not held, or held only by a guild, has no key (unknown, never empty)", () => {
  withFixture((store, readModel, imp) => {
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", [row(910011, 7, { name: "Warband Ore" })]),
      guild: guildSection("gclub-names", [row(910013, 40, { name: "Guild Only Herb" })]),
    });
    store.createDemand({ baseItemId: 910011, requiredQuantity: 3 });
    store.createDemand({ baseItemId: 910012, requiredQuantity: 100 }); // not held anywhere
    store.createDemand({ baseItemId: 910013, requiredQuantity: 5 }); // guild-owned only
    const data = review(readModel);
    assert.deepEqual(data.itemNames, { 910011: "Warband Ore" });
    const map = projectAccountOwnedEvidenceMap(store, "retail");
    assert.equal(itemNameForItem(map, 910013), undefined, "guild evidence is never consulted, even for a name");
    assert.equal(itemNameForItem(map, 910012), undefined);
  });
});

test("itemNames: a LAST_SEEN-only item is named from historical evidence (presentation only; quantities stay separate)", () => {
  withFixture((store, readModel, imp) => {
    imp({ name: "Anchor", generated: T, bags: observedSection([]), bank: observedSection([]), warband: warbandSection("LAST_SEEN", [row(910021, 8, { name: "Old Cloth" })]) });
    store.createDemand({ baseItemId: 910021, requiredQuantity: 5 });
    const data = review(readModel);
    assert.equal(data.itemNames[910021], "Old Cloth");
    const result = data.demanded.items[0]!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution === "RESOLVED") {
      assert.equal(result.confirmedAvailable, 0, "LAST_SEEN never satisfies demand");
      assert.equal(result.potentialAdditionalAvailable, 8);
    }
  });
});

test("Slice 3 parity holds with the sidecar and with a search: every demanded entry deep-equals getItemAllocation and carries no name", () => {
  withFixture((store, readModel, imp) => {
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([row(910031, 5, { name: "Short Mat" }), row(910032, 5, { name: "Variant Gem", ref: "item:910032::::::::80:::::1:1" }), row(910032, 5, { name: "Variant Gem", ref: "item:910032::::::::80:::::1:2" }), row(910033, 30, { name: "Sale Mat" })]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
    });
    for (const id of [910031, 910032, 910033]) store.createDemand({ baseItemId: id, requiredQuantity: 10 });
    for (const q of [undefined, "", "mat", "910032"]) {
      const data = review(readModel, q === undefined ? {} : { q });
      assert.equal(data.demanded.totalCount, 3, "search never filters demanded");
      for (const result of data.demanded.items) {
        assert.ok(!("name" in result), "the name is a sidecar, never part of AllocationResult");
        assert.deepEqual(result, readModel.getItemAllocation({ version: "retail", baseItemId: result.commodity.baseItemId }).data);
      }
    }
  });
});

// --- B. unallocated search --------------------------------------------------------------------------------------

function searchFixture(run: (readModel: DashboardReadModel) => void) {
  withFixture((store, readModel, imp) => {
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([
        row(920001, 3, { name: "Hearthstone" }),
        row(920002, 9, { name: "Heartwood Plank" }),
        row(920003, 4, { name: "Iron Ore" }),
        row(920004, 2, { name: "Silver Ore", ref: "item:920004" }), // bare row: ITEM_STRING_INCOMPLETE
        row(920005, 1, { name: null }), // no observed name
        row(920010, 6, { name: "Demanded Thing" }),
      ]),
      bank: observedSection([row(920006, 5, { name: "SHEARTH Cloth" })]),
      warband: warbandSection("OBSERVED", [row(920007, 7, { name: "Thorium Ore" })]),
    });
    store.createDemand({ baseItemId: 920010, requiredQuantity: 1 });
    run(readModel);
  });
}

test("search: case-insensitive name substring over unallocated entries, order preserved", () => {
  searchFixture((readModel) => {
    assert.deepEqual(ids(review(readModel, { q: "HEART" })), [920001, 920002, 920006]);
    assert.deepEqual(ids(review(readModel, { q: "  ore " })), [920003, 920004, 920007], "trimmed");
    assert.deepEqual(ids(review(readModel, { q: "demanded" })), [], "a demanded item is never unallocated, so search cannot surface it there");
  });
});

test("search: an all-digit query matches an exact base item id (including an item with no observed name)", () => {
  searchFixture((readModel) => {
    assert.deepEqual(ids(review(readModel, { q: "920005" })), [920005], "a nameless held item is still reachable");
    assert.deepEqual(ids(review(readModel, { q: "92000" })), [], "ids match exactly, never as a prefix");
  });
});

test("search filters BEFORE paging: totalCount and truncated describe the matches, pages walk the matches", () => {
  searchFixture((readModel) => {
    const first = review(readModel, { q: "ore", unallocatedLimit: 2 });
    assert.deepEqual(ids(first), [920003, 920004]);
    assert.equal(first.unallocated.totalCount, 3);
    assert.equal(first.unallocated.truncated, true);
    const second = review(readModel, { q: "ore", unallocatedOffset: 2, unallocatedLimit: 2 });
    assert.deepEqual(ids(second), [920007]);
    assert.equal(second.unallocated.totalCount, 3);
    assert.equal(second.unallocated.truncated, false);
  });
});

test("search keeps whole-list fields whole-account; an empty or blank query is exactly no query", () => {
  searchFixture((readModel) => {
    const none = review(readModel);
    assert.equal(none.unallocated.totalCount, 7);
    const searched = review(readModel, { q: "heart" });
    assert.deepEqual(searched.unallocatedItemStringIdentityCounts, none.unallocatedItemStringIdentityCounts, "identity counts describe the whole unallocated list, not the matches");
    assert.equal(none.unallocatedItemStringIdentityCounts.confirmed.ITEM_STRING_INCOMPLETE, 1);
    assert.deepEqual(searched.dispositionCounts, none.dispositionCounts);
    assert.deepEqual(searched.unresolvedStorage, none.unresolvedStorage);
    assert.deepEqual(searched.demanded, none.demanded);
    assert.deepEqual(review(readModel, { q: "" }), none);
    assert.deepEqual(review(readModel, { q: "   " }), none);
  });
});

test("filterUnallocatedByQuery (pure): blank returns a copy, matches never mutate or reorder, names absent never match text", () => {
  const entries = [{ baseItemId: 5, name: "Alpha" }, { baseItemId: 50 }, { baseItemId: 7, name: "beta 50" }];
  const same = filterUnallocatedByQuery(entries, undefined);
  assert.deepEqual(same, entries);
  assert.notEqual(same, entries);
  assert.deepEqual(filterUnallocatedByQuery(entries, "50").map((e) => e.baseItemId), [50, 7], "exact id OR name substring");
  assert.deepEqual(filterUnallocatedByQuery(entries, "ALPHA").map((e) => e.baseItemId), [5]);
  assert.deepEqual(filterUnallocatedByQuery(entries, "zzz"), []);
});

test("non-Retail: UNKNOWN provenance and no data, with or without a search", () => {
  searchFixture((readModel) => {
    for (const version of ["classic-era", "tbc-anniversary", "forever"] as const) {
      const read = readModel.getAllocationReview({ version, q: "ore" });
      assert.equal(read.provenance.state, "UNKNOWN");
      assert.equal(read.data, undefined);
    }
  });
});
