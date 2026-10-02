// Azeroth ERP Vertical Slice 1, end to end: DashboardReadModel.getItemAllocation against a real
// SqliteSnapshotStore with imported character/Warband/Guild exports, exercising the account-owned-
// evidence adapter (projectAccountOwnedEvidence) for real rather than through hand-built evidence (see
// allocation.test.ts for the pure-function scenario coverage). Each scenario uses its own in-memory
// store and its own base item id so evidence never leaks between scenarios.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import type { AccountBankSection, GuildBankSection, InventoryItemRecord, InventorySection } from "../src/types.ts";
import { renderExport, type ExportSpec } from "./sharedStorageExports.ts";

const T = 1_790_000_000;
const NOW = 1_790_100_000;

const itemRef = (id: number) => `item:${id}::::::::`;
const itemRow = (id: number, qty: number): InventoryItemRecord => ({ itemRef: itemRef(id), name: `Allocation fixture ${id}`, qty, bound: "no", vendorEachCopper: 100 });

/** An OBSERVED character storage section (bags or bank) carrying exactly the given items. Fully resolved on purpose: tests that must have zero unresolved evidence use this for every section they populate. */
function observedSection(items: InventoryItemRecord[], observedAt = T): InventorySection {
  return {
    status: { state: "OBSERVED", completeness: "complete", observedAt },
    containers: [{ id: 0, capacity: 16, free: 16 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 16 - items.length,
    totalSlots: 16,
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
    guildName: "Allocation Fixture Guild",
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

test("Scenario 1 — confirmed deficit: demand 40, OBSERVED 27, read through the DashboardReadModel", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800001;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 27)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 40 });
    const read = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM });
    assert.equal(read.provenance.state, "DERIVED");
    const result = read.data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedAvailable, 27);
    assert.equal(result.allocated, 27);
    assert.equal(result.confirmedDeficit, 13);
    assert.equal(result.confirmedSurplus, 0);
    assert.equal(result.disposition, "HOLD_ALLOCATED");
  });
});

test("Scenario 2 — confirmed surplus: demand 20, OBSERVED 35, fully resolved evidence recommends SEND_HELLOMAGS", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800002;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 35)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.allocated, 20);
    assert.equal(result.confirmedSurplus, 15);
    assert.equal(result.hasUnresolvedEvidence, false);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
  });
});

test("Scenario 3 — historical ambiguity: demand 40, OBSERVED 27, LAST_SEEN Warband 25 never satisfies or creates surplus", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800003;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 27)]), bank: observedSection([]), warband: warbandSection("LAST_SEEN", [itemRow(ITEM, 25)]) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 40 });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedAvailable, 27);
    assert.equal(result.allocated, 27);
    assert.equal(result.confirmedDeficit, 13);
    assert.equal(result.potentialAdditionalAvailable, 25);
    assert.equal(result.confirmedSurplus, 0);
    assert.equal(result.disposition, "HOLD_ALLOCATED");
  });
});

test("Scenario 4 — UNKNOWN is not zero / conservative gate: demand 20, OBSERVED 35, character bank left UNKNOWN", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800004;
    // bank omitted entirely -> renders State: UNKNOWN, exactly the "relevant account-owned scope is unresolved" case.
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 35)]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedAvailable, 35);
    assert.equal(result.allocated, 20);
    assert.equal(result.confirmedDeficit, 0);
    assert.equal(result.confirmedSurplus, 15);
    assert.equal(result.hasUnresolvedEvidence, true);
    assert.deepEqual(result.unresolvedScopes, ["character-bank"]);
    assert.equal(result.disposition, "REQUIRES_REVIEW", "a confirmed floor surplus never auto-recommends sale routing while relevant evidence is unresolved");
  });
});

test("Scenario 5 — guild isolation: demand 20, account OBSERVED 10, Guild OBSERVED 100 stays out of account availability and surplus", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800005;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([itemRow(ITEM, 10)]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
      guild: guildSection("111", [itemRow(ITEM, 100)]),
    });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedAvailable, 10);
    assert.equal(result.allocated, 10);
    assert.equal(result.confirmedDeficit, 10);
    assert.equal(result.confirmedSurplus, 0);
    assert.equal(result.guildContext.length, 1);
    assert.equal(result.guildContext[0]!.quantity, 100);
    assert.ok(result.reasons.some((r) => r.code === "GUILD_EVIDENCE_EXCLUDED"));
  });
});

test("Scenario 6 — no demand: OBSERVED 500 never becomes '500 surplus'", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800006;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 500)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    // Deliberately no store.createDemand call.
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "NO_ACTIVE_DEMAND");
    assert.ok(!("confirmedSurplus" in result));
    assert.equal(result.disposition, "NO_ACTION");
  });
});

test("a Warband that has never been observed at all is an unresolved scope, never an implicit zero", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800007;
    // No warband field at all -> "[ACCOUNT BANK] State: UNKNOWN" -> the Warband owner has no journal entry.
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 12)]), bank: observedSection([]) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 5 });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.hasUnresolvedEvidence, true);
    assert.ok(result.unresolvedScopes.includes("warband"));
    // Surplus is still a safe floor (12 - 5 = 7), but gated.
    assert.equal(result.confirmedSurplus, 7);
    assert.equal(result.disposition, "REQUIRES_REVIEW");
  });
});

test("getItemAllocation requires an explicit version and never defaults to Retail", () => {
  withFixture((_store, readModel) => {
    assert.throws(() => readModel.getItemAllocation({ version: undefined as never, baseItemId: 1 }), TypeError);
  });
});

test("getItemAllocation is Retail-only in this slice: a recognized non-Retail version returns UNKNOWN provenance, not an error and not Retail data", () => {
  withFixture((_store, readModel) => {
    const read = readModel.getItemAllocation({ version: "classic-era", baseItemId: 1 });
    assert.equal(read.provenance.state, "UNKNOWN");
    assert.equal(read.data, undefined);
  });
});
