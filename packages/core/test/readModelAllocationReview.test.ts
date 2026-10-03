// Azeroth ERP Vertical Slice 2 — Account Allocation Review, end to end: DashboardReadModel.getAllocationReview
// against a real SqliteSnapshotStore with imported character/Warband/Guild exports. The central claim under
// test: UNALLOCATED INVENTORY IS NOT SURPLUS, and every demanded result is exactly what Slice 1's per-item
// getItemAllocation returns (one projection, one allocator).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel, type AccountAllocationReview, type UnallocatedInventoryRead } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildAllocationReview } from "../src/allocationReview.ts";
import { commodityIdentity, type ExplicitDemand } from "../src/demand.ts";
import type { AccountOwnedEvidenceMap } from "../src/allocation.ts";
import type { AccountBankSection, GuildBankSection, InventoryItemRecord, InventorySection } from "../src/types.ts";
import { renderExport, type ExportSpec } from "./sharedStorageExports.ts";

const T = 1_790_000_000;
const NOW = 1_790_100_000;

const itemRef = (id: number) => `item:${id}::::::::`;
const itemRow = (id: number, qty: number | undefined): InventoryItemRecord => ({ itemRef: itemRef(id), name: `Review fixture ${id}`, qty, bound: "no", vendorEachCopper: 100 });

function observedSection(items: InventoryItemRecord[], observedAt = T): InventorySection {
  return {
    status: { state: "OBSERVED", completeness: "complete", observedAt },
    containers: [{ id: 0, capacity: 40, free: 40 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 40 - items.length,
    totalSlots: 40,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

function warbandSection(state: "OBSERVED" | "LAST_SEEN", items: InventoryItemRecord[], observedAt = T): AccountBankSection {
  return {
    status: { state, completeness: "complete", observedAt },
    ownerScope: "ACCOUNT_WARBAND",
    coverage: "ACCOUNT/Warband purchased tabs only",
    snapshotVisit: observedAt - 1,
    purchasedBankTabs: 1,
    containers: [{ id: 12, storage: "ACCOUNT_WARBAND", capacity: 98, free: 98 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 98 - items.length,
    totalSlots: 98,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

function guildSection(clubId: string, items: InventoryItemRecord[], observedAt = T): GuildBankSection {
  return {
    status: { state: "OBSERVED", completeness: "complete", observedAt },
    ownerScope: "GUILD",
    guildClubId: clubId,
    guildName: "Review Fixture Guild",
    coverage: "All tabs currently reported viewable were serialized through QueryGuildBankTab; inaccessible tabs were not scanned.",
    snapshotVisit: observedAt - 5,
    tabs: [{ id: 1, name: "Tab 1", viewable: true, state: "OBSERVED" }],
    containers: [{ id: 1, storage: "GUILD", capacity: 98, free: 98 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 98 - items.length,
    totalSlots: 98,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

function withFixture(run: (store: SqliteSnapshotStore, readModel: DashboardReadModel, imp: (spec: ExportSpec) => void) => void): void {
  const store = new SqliteSnapshotStore(":memory:");
  const readModel = new DashboardReadModel(store, () => NOW);
  try {
    run(store, readModel, (spec) => void store.importSnapshot(renderExport(spec)));
  } finally {
    store.close();
  }
}

function review(readModel: DashboardReadModel, paging: { demandedLimit?: number; unallocatedLimit?: number } = {}): AccountAllocationReview {
  const read = readModel.getAllocationReview({ version: "retail", demandedLimit: 100, unallocatedLimit: 100, ...paging });
  assert.equal(read.provenance.state, "DERIVED");
  return read.data!;
}

const unallocatedIds = (data: AccountAllocationReview) => data.unallocated.items.map((entry) => entry.baseItemId);
const entryFor = (data: AccountAllocationReview, id: number): UnallocatedInventoryRead => {
  const entry = data.unallocated.items.find((e) => e.baseItemId === id);
  assert.ok(entry, `expected unallocated entry for ${id}`);
  return entry;
};

/** Fields an unallocated entry must never carry, structurally — not zero-valued, absent. */
const FORBIDDEN_UNALLOCATED_FIELDS = ["surplus", "confirmedSurplus", "disposition", "allocated", "confirmedDeficit", "demand", "recommendation", "resolution"];

test("Slice 2 Scenario 1 — no active demands: held account-owned items are unallocated, with no surplus or disposition field at all", () => {
  withFixture((_store, readModel, imp) => {
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(900002, 5), itemRow(900001, 30)]), bank: observedSection([itemRow(900003, 2)]), warband: warbandSection("OBSERVED", [itemRow(900004, 7)]) });
    const data = review(readModel);
    assert.equal(data.demanded.totalCount, 0);
    assert.deepEqual(data.dispositionCounts, { HOLD_ALLOCATED: 0, REQUIRES_REVIEW: 0, SEND_HELLOMAGS: 0, NO_ACTION: 0 });
    assert.deepEqual(unallocatedIds(data), [900001, 900002, 900003, 900004]);
    assert.equal(data.hasUnresolvedStorage, false);
    for (const entry of data.unallocated.items) {
      assert.equal(entry.allocationState, "UNALLOCATED");
      for (const field of FORBIDDEN_UNALLOCATED_FIELDS) assert.ok(!(field in entry), `unallocated entry must not carry "${field}"`);
      assert.equal(entry.hasUnresolvedEvidence, false);
    }
    assert.equal(entryFor(data, 900001).confirmedQuantity, 30);
    const warbandHeld = entryFor(data, 900004);
    assert.equal(warbandHeld.confirmedQuantity, 7);
    assert.deepEqual(warbandHeld.holdings.map((h) => h.scope), ["warband"]);
    assert.equal(entryFor(data, 900003).holdings[0]!.scope, "character-bank");
  });
});

test("Slice 2 Scenario 2 — multiple demanded items: deficit, clean surplus, review gate and no-action results each equal getItemAllocation for the same item", () => {
  withFixture((store, readModel, imp) => {
    const DEFICIT = 900011, SURPLUS = 900012, GATED = 900013, EXACT = 900014, LOOSE = 900015;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(DEFICIT, 27), itemRow(SURPLUS, 35), itemRow(GATED, 35), itemRow(EXACT, 10), itemRow(LOOSE, 3)]),
      // A present GATED row with unreported quantity: the only unresolved evidence on the account.
      bank: observedSection([itemRow(GATED, undefined)]),
      warband: warbandSection("OBSERVED", []),
    });
    store.createDemand({ baseItemId: DEFICIT, requiredQuantity: 40 });
    store.createDemand({ baseItemId: SURPLUS, requiredQuantity: 20 });
    store.createDemand({ baseItemId: GATED, requiredQuantity: 20 });
    store.createDemand({ baseItemId: EXACT, requiredQuantity: 10 });
    const data = review(readModel);
    assert.deepEqual(data.demanded.items.map((r) => [r.commodity.baseItemId, r.disposition]), [
      [DEFICIT, "HOLD_ALLOCATED"],
      [GATED, "REQUIRES_REVIEW"],
      [SURPLUS, "SEND_HELLOMAGS"],
      [EXACT, "NO_ACTION"],
    ]);
    assert.deepEqual(data.dispositionCounts, { HOLD_ALLOCATED: 1, REQUIRES_REVIEW: 1, SEND_HELLOMAGS: 1, NO_ACTION: 1 });
    for (const result of data.demanded.items) {
      assert.deepEqual(result, readModel.getItemAllocation({ version: "retail", baseItemId: result.commodity.baseItemId }).data, `review and getItemAllocation agree for ${result.commodity.baseItemId}`);
    }
    const surplus = data.demanded.items.find((r) => r.commodity.baseItemId === SURPLUS)!;
    assert.equal(surplus.resolution, "RESOLVED");
    if (surplus.resolution === "RESOLVED") assert.equal(surplus.confirmedSurplus, 15);
    // Scenario 3 — mutual exclusion: the four demanded items are never also unallocated; the undemanded one is.
    assert.deepEqual(unallocatedIds(data), [LOOSE]);
  });
});

test("Slice 2 Scenario 3 — mutual exclusion holds across every demanded and held item", () => {
  withFixture((store, readModel, imp) => {
    const ids = [900021, 900022, 900023, 900024, 900025, 900026];
    imp({ name: "Anchor", generated: T, bags: observedSection(ids.map((id) => itemRow(id, 4))), bank: observedSection([]), warband: warbandSection("OBSERVED", [itemRow(900022, 9)]) });
    store.createDemand({ baseItemId: 900022, requiredQuantity: 1 });
    store.createDemand({ baseItemId: 900025, requiredQuantity: 100 });
    store.createDemand({ baseItemId: 900099, requiredQuantity: 5 }); // demanded, held nowhere
    const data = review(readModel);
    const demanded = new Set(data.demanded.items.map((r) => r.commodity.baseItemId));
    const unallocated = new Set(unallocatedIds(data));
    assert.deepEqual([...demanded].filter((id) => unallocated.has(id)), []);
    assert.deepEqual([...demanded].sort(), [900022, 900025, 900099]);
    assert.deepEqual([...unallocated], [900021, 900023, 900024, 900026]);
  });
});

test("Slice 2 Scenario 4 — LAST_SEEN separation: historical-only inventory reports confirmed 0 and potential N, never summed", () => {
  withFixture((_store, readModel, imp) => {
    const HISTORICAL = 900031, MIXED = 900032;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(MIXED, 10)]), bank: observedSection([]), warband: warbandSection("LAST_SEEN", [itemRow(HISTORICAL, 25), itemRow(MIXED, 25)]) });
    const data = review(readModel);
    const historical = entryFor(data, HISTORICAL);
    assert.equal(historical.confirmedQuantity, 0);
    assert.equal(historical.potentialQuantity, 25);
    assert.deepEqual(historical.holdings.map((h) => [h.scope, h.admissibility, h.quantity]), [["warband", "POTENTIAL", 25]]);
    const mixed = entryFor(data, MIXED);
    assert.equal(mixed.confirmedQuantity, 10);
    assert.equal(mixed.potentialQuantity, 25);
  });
});

test("Slice 2 Scenario 5 — UNKNOWN storage is surfaced once as unresolved, invents no quantity, and is never zero", () => {
  withFixture((_store, readModel, imp) => {
    const HELD = 900041;
    // bank omitted -> State: UNKNOWN
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(HELD, 12)]), warband: warbandSection("OBSERVED", []) });
    const data = review(readModel);
    assert.equal(data.hasUnresolvedStorage, true);
    assert.equal(data.unresolvedStorage.length, 1);
    assert.equal(data.unresolvedStorage[0]!.scope, "character-bank");
    assert.ok(data.unresolvedStorage[0]!.identityKey);
    assert.ok(!("quantity" in data.unresolvedStorage[0]!));
    const entry = entryFor(data, HELD);
    assert.equal(entry.confirmedQuantity, 12, "only observed bags count; the UNKNOWN bank adds nothing and subtracts nothing");
    assert.equal(entry.hasUnresolvedEvidence, true);
    assert.deepEqual(entry.unresolvedScopes, ["character-bank"]);
    assert.ok(entry.holdings.every((h) => h.admissibility !== "UNRESOLVED"), "whole-scope UNKNOWN storage is reported once at the review level, not as a per-item holding");
  });
});

test("Slice 2 Scenario 6 — guild only: an item held only by a guild is never unallocated and changes no account arithmetic", () => {
  withFixture((store, readModel, imp) => {
    const GUILD_ONLY = 900051, ACCOUNT = 900052, GUILD_DEMANDED = 900053;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(ACCOUNT, 1)]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
      guild: guildSection("222", [itemRow(GUILD_ONLY, 100), itemRow(ACCOUNT, 40), itemRow(GUILD_DEMANDED, 500)]),
    });
    store.createDemand({ baseItemId: GUILD_DEMANDED, requiredQuantity: 20 });
    const data = review(readModel);
    assert.deepEqual(unallocatedIds(data), [ACCOUNT]);
    const account = entryFor(data, ACCOUNT);
    assert.equal(account.confirmedQuantity, 1);
    assert.equal(account.guildContext[0]!.quantity, 40, "guild evidence is visible as context only");
    const guildDemanded = data.demanded.items[0]!;
    assert.equal(guildDemanded.resolution, "RESOLVED");
    if (guildDemanded.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(guildDemanded.confirmedAvailable, 0);
    assert.equal(guildDemanded.confirmedDeficit, 20);
    assert.equal(guildDemanded.disposition, "HOLD_ALLOCATED");
  });
});

test("Slice 2 Scenario 7 — a Warband never observed stays unresolved, never zero", () => {
  withFixture((_store, readModel, imp) => {
    const HELD = 900061;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(HELD, 3)]), bank: observedSection([]) });
    const data = review(readModel);
    assert.deepEqual(data.unresolvedStorage, [{ scope: "warband" }]);
    const entry = entryFor(data, HELD);
    assert.equal(entry.hasUnresolvedEvidence, true);
    assert.deepEqual(entry.unresolvedScopes, ["warband"]);
    assert.ok(entry.holdings.every((h) => h.scope !== "warband"));
  });
});

test("Slice 2 Scenario 8 — an INACTIVE demand allocates nothing; its held item is unallocated", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 900071;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 8)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    const demand = store.createDemand({ baseItemId: ITEM, requiredQuantity: 5 });
    assert.equal(review(readModel).demanded.totalCount, 1);
    store.deactivateDemand(demand.stableId);
    const data = review(readModel);
    assert.equal(data.demanded.totalCount, 0);
    assert.deepEqual(unallocatedIds(data), [ITEM]);
    assert.equal(entryFor(data, ITEM).confirmedQuantity, 8);
  });
});

test("Slice 2 Scenario 9 — explicit version required; non-Retail returns UNKNOWN provenance, never Retail data", () => {
  withFixture((_store, readModel, imp) => {
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(900081, 1)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    assert.throws(() => readModel.getAllocationReview({ version: undefined as never }), TypeError);
    assert.throws(() => readModel.getAllocationReview({ version: "mainline" as never }), TypeError);
    for (const version of ["classic-era", "tbc-anniversary", "forever", "unknown-version"] as const) {
      const read = readModel.getAllocationReview({ version });
      assert.equal(read.provenance.state, "UNKNOWN");
      assert.equal(read.data, undefined);
    }
    assert.equal(readModel.getAllocationReview({ version: "retail" }).data?.unallocated.totalCount, 1);
  });
});

test("Slice 2 Scenario 11 — paging is bounded and deterministic, and pages neither duplicate nor lose entries", () => {
  withFixture((store, readModel, imp) => {
    const held = Array.from({ length: 7 }, (_, i) => 900200 + i);
    imp({ name: "Anchor", generated: T, bags: observedSection(held.map((id) => itemRow(id, 1)).reverse()), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    imp({ name: "Second", generated: T, bags: observedSection([itemRow(900300, 2)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    for (const id of [900301, 900302, 900303]) store.createDemand({ baseItemId: id, requiredQuantity: 1 });

    const full = review(readModel);
    assert.deepEqual(review(readModel), full, "two reads of unchanged evidence are identical");
    const pages: number[] = [];
    for (let offset = 0; offset < full.unallocated.totalCount; offset += 3) {
      const page = readModel.getAllocationReview({ version: "retail", unallocatedOffset: offset, unallocatedLimit: 3 }).data!.unallocated;
      assert.equal(page.totalCount, 8);
      assert.equal(page.truncated, offset + 3 < 8);
      pages.push(...page.items.map((e) => e.baseItemId));
    }
    assert.deepEqual(pages, unallocatedIds(full));
    assert.equal(new Set(pages).size, 8);

    const demandedPages = [0, 2].flatMap((offset) => readModel.getAllocationReview({ version: "retail", demandedOffset: offset, demandedLimit: 2 }).data!.demanded.items.map((r) => r.commodity.baseItemId));
    assert.deepEqual(demandedPages, [900301, 900302, 900303]);
    const firstDemandedPage = readModel.getAllocationReview({ version: "retail", demandedLimit: 2 }).data!;
    assert.equal(firstDemandedPage.demanded.truncated, true);
    assert.deepEqual(firstDemandedPage.dispositionCounts, full.dispositionCounts, "summary counts cover every demanded item, not only the page");

    assert.equal(readModel.getAllocationReview({ version: "retail", unallocatedLimit: 500 }).data!.unallocated.limit, 100);
    assert.equal(readModel.getAllocationReview({ version: "retail" }).data!.unallocated.limit, 50);
    assert.throws(() => readModel.getAllocationReview({ version: "retail", unallocatedOffset: -1 }), TypeError);
    assert.throws(() => readModel.getAllocationReview({ version: "retail", demandedLimit: 0 }), TypeError);
    const beyond = readModel.getAllocationReview({ version: "retail", unallocatedOffset: 50 }).data!.unallocated;
    assert.deepEqual([beyond.items.length, beyond.totalCount, beyond.truncated], [0, 8, false]);
  });
});

test("Slice 2 Scenario 12 — a present row with unknown quantity is uncertainty, never an observed zero", () => {
  withFixture((store, readModel, imp) => {
    const PARTIAL = 900091, ALL_UNKNOWN = 900092, HISTORICAL_UNKNOWN = 900093;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(PARTIAL, 10), itemRow(PARTIAL, undefined), itemRow(ALL_UNKNOWN, undefined)]),
      bank: observedSection([]),
      warband: warbandSection("LAST_SEEN", [itemRow(HISTORICAL_UNKNOWN, undefined)]),
    });
    const data = review(readModel);
    assert.equal(data.hasUnresolvedStorage, false, "no whole storage scope is UNKNOWN; the uncertainty is item-specific");

    const partial = entryFor(data, PARTIAL);
    assert.equal(partial.confirmedQuantity, 10, "reported rows form a confirmed floor");
    assert.equal(partial.hasUnresolvedEvidence, true);
    assert.deepEqual(partial.unresolvedScopes, ["character-bags"]);
    const confirmed = partial.holdings.find((h) => h.admissibility === "CONFIRMED")!;
    assert.equal(confirmed.unknownQuantityRowCount, 1);
    const unresolved = partial.holdings.find((h) => h.admissibility === "UNRESOLVED")!;
    assert.equal(unresolved.unresolvedCause, "ITEM_QUANTITY_UNKNOWN");
    assert.ok(!("quantity" in unresolved));

    const allUnknown = entryFor(data, ALL_UNKNOWN);
    assert.equal(allUnknown.hasUnresolvedEvidence, true, "an item whose only rows have unknown quantity is still listed, flagged unresolved");

    const historical = entryFor(data, HISTORICAL_UNKNOWN);
    assert.equal(historical.potentialQuantity, 0);
    assert.equal(historical.holdings[0]!.unknownQuantityRowCount, 1);
    assert.equal(historical.hasUnresolvedEvidence, false, "historical rows cannot reach confirmed numbers, so they cannot gate them");

    // The same correction reaches Slice 1: the floor surplus is gated rather than auto-recommended for sale.
    store.createDemand({ baseItemId: PARTIAL, requiredQuantity: 5 });
    const allocation = readModel.getItemAllocation({ version: "retail", baseItemId: PARTIAL }).data!;
    assert.equal(allocation.resolution, "RESOLVED");
    if (allocation.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(allocation.confirmedAvailable, 10);
    assert.equal(allocation.confirmedSurplus, 5);
    assert.equal(allocation.disposition, "REQUIRES_REVIEW");
    assert.ok(allocation.reasons.some((r) => r.code === "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"));
  });
});

test("Slice 2 — the evidence is projected once per review: listSnapshots is called once per character, never once per item", () => {
  withFixture((store, readModel, imp) => {
    const ids = Array.from({ length: 30 }, (_, i) => 900400 + i);
    imp({ name: "Anchor", generated: T, bags: observedSection(ids.slice(0, 15).map((id) => itemRow(id, 1))), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    imp({ name: "Second", generated: T, bags: observedSection(ids.slice(15).map((id) => itemRow(id, 1))), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    for (const id of ids.slice(0, 5)) store.createDemand({ baseItemId: id, requiredQuantity: 1 });
    const original = store.listSnapshots.bind(store);
    let snapshotReads = 0;
    let sharedProjections = 0;
    const originalProjection = store.projectSharedStorage.bind(store);
    store.listSnapshots = (identityKey: string) => { snapshotReads++; return original(identityKey); };
    store.projectSharedStorage = () => { sharedProjections++; return originalProjection(); };
    const data = review(readModel);
    assert.equal(data.demanded.totalCount + data.unallocated.totalCount, 30);
    assert.equal(snapshotReads, 2);
    assert.equal(sharedProjections, 1);
  });
});

test("Slice 2 — item metadata enriches but never filters: unknown metadata keeps held inventory visible; unidentifiable rows are counted", () => {
  withFixture((_store, readModel, imp) => {
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(900501, 4), itemRow(900502, 6), { itemRef: "not-an-item-ref", name: "Mystery", qty: 1 }]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
      itemMetadata: [{ id: 900501, classId: 7, subclassId: 5, bindType: 0, expansionId: 11, reagent: true }],
    });
    const data = review(readModel);
    assert.deepEqual(unallocatedIds(data), [900501, 900502]);
    assert.equal(entryFor(data, 900501).metadataState, "KNOWN");
    assert.equal(entryFor(data, 900502).metadataState, "UNKNOWN");
    assert.ok(!("metadata" in entryFor(data, 900502)));
    assert.equal(data.unidentifiedItemRowCount, 1);
  });
});

test("Slice 2 pure assembly — contradictory active demands for one item surface as CONFLICTING_DEMAND, inactive demands are ignored, guild-only items never become unallocated", () => {
  const demand = (stableId: string, baseItemId: number, status: "ACTIVE" | "INACTIVE" = "ACTIVE"): ExplicitDemand => ({ stableId, gameVersion: "retail", demandType: "STOCK_TARGET", commodity: commodityIdentity(baseItemId), requiredQuantity: 1, status, createdAt: T, updatedAt: T });
  const map: AccountOwnedEvidenceMap = {
    scopes: [{ scope: "character-bags", admissibility: "CONFIRMED", identityKey: "retail::r::a", observedAt: T, items: new Map([[1, { knownQuantity: 3, unknownQuantityRowCount: 0 }], [2, { knownQuantity: 4, unknownQuantityRowCount: 0 }]]) }],
    guilds: [{ ownerKey: "guild:9", admissibility: "CONFIRMED", observedAt: T, items: new Map([[3, { knownQuantity: 50, unknownQuantityRowCount: 0 }]]) }],
    unidentifiedItemRowCount: 0,
  };
  const parts = buildAllocationReview(map, [demand("d-b", 1), demand("d-a", 1), demand("d-c", 2, "INACTIVE")]);
  assert.equal(parts.demanded.length, 1);
  const conflict = parts.demanded[0]!;
  assert.equal(conflict.resolution, "CONFLICTING_DEMAND");
  if (conflict.resolution === "CONFLICTING_DEMAND") assert.deepEqual(conflict.conflictingDemandIds, ["d-a", "d-b"]);
  assert.equal(parts.dispositionCounts.REQUIRES_REVIEW, 1);
  assert.deepEqual(parts.unallocated.map((e) => e.baseItemId), [2]);
});
