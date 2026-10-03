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
      assert.equal(entry.potentialUnknownQuantityRowCount, 0, "fully known entries state zero unknown historical rows explicitly");
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
    assert.equal(historical.potentialUnknownQuantityRowCount, 1, "potentialQuantity 0 is a known floor, not a known historical zero");
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
    assert.ok(allocation.reasons.some((r) => r.code === "ITEM_QUANTITY_UNKNOWN_PRESENT"));
    assert.ok(!allocation.reasons.some((r) => r.code === "UNRESOLVED_STORAGE_PRESENT"), "the bags were observed; only an item quantity is unknown");
  });
});

const reasonCodes = (result: { reasons: Array<{ code: string }> }) => result.reasons.map((r) => r.code);

test("Slice 2 correction — LAST_SEEN unknown quantity: entry-level floor marker, never a known historical zero, never a gate", () => {
  withFixture((store, readModel, imp) => {
    const HISTORICAL_ONLY = 900601, HISTORICAL_MIXED = 900602, CONFIRMED_PLUS_HISTORICAL = 900603;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(CONFIRMED_PLUS_HISTORICAL, 30)]),
      bank: observedSection([]),
      warband: warbandSection("LAST_SEEN", [itemRow(HISTORICAL_ONLY, undefined), itemRow(HISTORICAL_MIXED, 25), itemRow(HISTORICAL_MIXED, undefined), itemRow(CONFIRMED_PLUS_HISTORICAL, undefined)]),
    });
    const data = review(readModel);

    // 1. LAST_SEEN-only, unknown quantity.
    const only = entryFor(data, HISTORICAL_ONLY);
    assert.equal(only.confirmedQuantity, 0);
    assert.equal(only.potentialQuantity, 0);
    assert.equal(only.potentialUnknownQuantityRowCount, 1);
    assert.equal(only.hasUnresolvedEvidence, false);
    assert.deepEqual(only.unresolvedScopes, []);

    // 2. LAST_SEEN known N plus one unknown row.
    const mixed = entryFor(data, HISTORICAL_MIXED);
    assert.equal(mixed.potentialQuantity, 25);
    assert.equal(mixed.potentialUnknownQuantityRowCount, 1);
    assert.equal(mixed.confirmedQuantity, 0);

    const confirmedPlusHistorical = entryFor(data, CONFIRMED_PLUS_HISTORICAL);
    assert.equal(confirmedPlusHistorical.confirmedQuantity, 30, "an unknown historical row never becomes confirmed");
    assert.equal(confirmedPlusHistorical.potentialUnknownQuantityRowCount, 1);
    assert.equal(confirmedPlusHistorical.hasUnresolvedEvidence, false);

    // A historical unknown quantity does not gate confirmed disposition: 30 confirmed vs demand 20 is a clean surplus.
    store.createDemand({ baseItemId: CONFIRMED_PLUS_HISTORICAL, requiredQuantity: 20 });
    const allocation = readModel.getItemAllocation({ version: "retail", baseItemId: CONFIRMED_PLUS_HISTORICAL }).data!;
    assert.equal(allocation.resolution, "RESOLVED");
    if (allocation.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(allocation.confirmedAvailable, 30);
    assert.equal(allocation.potentialAdditionalAvailable, 0);
    assert.equal(allocation.hasUnresolvedEvidence, false);
    assert.equal(allocation.disposition, "SEND_HELLOMAGS");
    assert.ok(reasonCodes(allocation).includes("LAST_SEEN_INVENTORY_PRESENT"), "LAST_SEEN evidence is reported even though its quantity is unknown");
    assert.ok(reasonCodes(allocation).includes("LAST_SEEN_NOT_ADMISSIBLE"));
  });
});

test("Slice 2 correction — demanded item with LAST_SEEN unknown quantity: never satisfies demand or becomes confirmed, but is explained", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 900611;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 10)]), bank: observedSection([]), warband: warbandSection("LAST_SEEN", [itemRow(ITEM, undefined)]) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 40 });
    const result = review(readModel).demanded.items[0]!;
    assert.deepEqual(result, readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedAvailable, 10);
    assert.equal(result.allocated, 10);
    assert.equal(result.confirmedDeficit, 30);
    assert.equal(result.potentialAdditionalAvailable, 0, "an unknown historical quantity is never counted");
    assert.equal(result.hasUnresolvedEvidence, false);
    assert.equal(result.disposition, "HOLD_ALLOCATED");
    const lastSeen = result.reasons.find((r) => r.code === "LAST_SEEN_INVENTORY_PRESENT");
    assert.ok(lastSeen, "LAST_SEEN evidence exists despite its unknown quantity");
    assert.match(lastSeen.detail ?? "", /unreported quantity/);
    assert.ok(reasonCodes(result).includes("LAST_SEEN_NOT_ADMISSIBLE"));
    assert.ok(!reasonCodes(result).includes("UNRESOLVED_STORAGE_PRESENT"));
    assert.ok(!reasonCodes(result).includes("ITEM_QUANTITY_UNKNOWN_PRESENT"));
  });
});

test("Slice 2 correction — unknown item quantity in OBSERVED storage is explained as item-quantity uncertainty, not unknown storage; the gate still holds", () => {
  withFixture((store, readModel, imp) => {
    const GATED = 900621, ALL_UNKNOWN = 900622;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(GATED, 35), itemRow(GATED, undefined), itemRow(ALL_UNKNOWN, undefined)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: GATED, requiredQuantity: 20 });
    store.createDemand({ baseItemId: ALL_UNKNOWN, requiredQuantity: 5 });
    const data = review(readModel);
    assert.equal(data.hasUnresolvedStorage, false);

    const gated = data.demanded.items.find((r) => r.commodity.baseItemId === GATED)!;
    assert.equal(gated.resolution, "RESOLVED");
    if (gated.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(gated.confirmedAvailable, 35, "known observed rows remain a confirmed floor");
    assert.equal(gated.confirmedSurplus, 15);
    assert.equal(gated.hasUnresolvedEvidence, true);
    assert.equal(gated.disposition, "REQUIRES_REVIEW");
    assert.ok(reasonCodes(gated).includes("SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"));
    assert.ok(reasonCodes(gated).includes("ITEM_QUANTITY_UNKNOWN_PRESENT"));
    assert.ok(!reasonCodes(gated).includes("UNRESOLVED_STORAGE_PRESENT"));

    // Reviewer's weak case: every CONFIRMED row of a demanded item has unknown quantity.
    const allUnknown = data.demanded.items.find((r) => r.commodity.baseItemId === ALL_UNKNOWN)!;
    assert.equal(allUnknown.resolution, "RESOLVED");
    if (allUnknown.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(allUnknown.confirmedAvailable, 0, "nothing of known quantity is confirmed; no quantity is invented");
    assert.equal(allUnknown.allocated, 0);
    assert.equal(allUnknown.confirmedDeficit, 5, "a floor deficit: it can only shrink once the unknown quantity is known");
    assert.equal(allUnknown.hasUnresolvedEvidence, true);
    assert.equal(allUnknown.disposition, "HOLD_ALLOCATED");
    assert.ok(reasonCodes(allUnknown).includes("ITEM_QUANTITY_UNKNOWN_PRESENT"));
    const confirmedRow = allUnknown.evidence.find((e) => e.admissibility === "CONFIRMED" && e.scope === "character-bags")!;
    assert.equal(confirmedRow.unknownQuantityRowCount, 1);
  });
});

test("Slice 2 correction — true UNKNOWN storage keeps storage-unknown reasoning, distinct from item-quantity uncertainty when both occur", () => {
  withFixture((store, readModel, imp) => {
    const STORAGE_ONLY = 900631, BOTH = 900632;
    // bank omitted -> State: UNKNOWN
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(STORAGE_ONLY, 35), itemRow(BOTH, 35), itemRow(BOTH, undefined)]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: STORAGE_ONLY, requiredQuantity: 20 });
    store.createDemand({ baseItemId: BOTH, requiredQuantity: 20 });
    const data = review(readModel);

    const storageOnly = data.demanded.items.find((r) => r.commodity.baseItemId === STORAGE_ONLY)!;
    assert.equal(storageOnly.disposition, "REQUIRES_REVIEW");
    const storageReason = storageOnly.reasons.find((r) => r.code === "UNRESOLVED_STORAGE_PRESENT");
    assert.ok(storageReason);
    assert.match(storageReason.detail ?? "", /character-bank/);
    assert.ok(!reasonCodes(storageOnly).includes("ITEM_QUANTITY_UNKNOWN_PRESENT"));

    const both = data.demanded.items.find((r) => r.commodity.baseItemId === BOTH)!;
    const bothStorage = both.reasons.find((r) => r.code === "UNRESOLVED_STORAGE_PRESENT");
    const bothQuantity = both.reasons.find((r) => r.code === "ITEM_QUANTITY_UNKNOWN_PRESENT");
    assert.ok(bothStorage && bothQuantity, "the two causes are reported separately, never collapsed");
    assert.match(bothStorage.detail ?? "", /character-bank/);
    assert.doesNotMatch(bothStorage.detail ?? "", /character-bags/, "the observed bags are never described as unknown storage");
    assert.match(bothQuantity.detail ?? "", /character-bags/);
    if (both.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.deepEqual([...both.unresolvedScopes].sort(), ["character-bags", "character-bank"]);
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
