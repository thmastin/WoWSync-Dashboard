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

test("active explicit project reservation gates sale disposition across allocation reads without claiming transfer access", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 800022;
    const GUILD_ITEM = ITEM + 1;
    imp({ name: "Anchor", generated: T, bags: observedSection([itemRow(ITEM, 35), itemRow(GUILD_ITEM, 15)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    const sourceIdentityKey = store.listCharacters("retail")[0]!.identityKey;
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const plan = store.createErpProject({
      version: "retail", title: "Reserve for a craft", needs: [{ stableId: "stone_need", kind: "ITEM_ID", resourceKey: String(ITEM), label: "Mycobloom", requiredQuantity: 5, sourceIdentityKey }],
      reservations: [{ stableId: "stone_hold", needId: "stone_need", sourceIdentityKey, quantity: 5, status: "ACTIVE", createdAt: NOW, updatedAt: NOW }], workOrders: [],
    });
    const result = readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data!;
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") throw new Error("unreachable");
    assert.equal(result.confirmedSurplus, 15, "stock-target arithmetic stays explicitly separate from project reservations");
    assert.equal(result.disposition, "REQUIRES_REVIEW", "a project-reserved resource cannot be offered to the sale pipeline");
    assert.ok(result.reasons.some((reason) => reason.code === "PROJECT_RESERVATION_GATES_SALE" && /Reserve for a craft.*5 reserved/.test(reason.detail ?? "")));
    assert.doesNotMatch(JSON.stringify(result.reasons), /transferable|account-owned by Anchor/);
    const review = readModel.getAllocationReview({ version: "retail" }).data!;
    const entry = review.demanded.items.find((candidate) => candidate.commodity.baseItemId === ITEM)!;
    assert.deepEqual(entry, result, "the single-item REST/core read and portfolio review apply the same reservation gate");
    assert.equal(review.dispositionCounts.REQUIRES_REVIEW, 1);

    store.updateErpProject({ ...plan, reservations: plan.reservations.map((reservation) => ({ ...reservation, status: "RELEASED" as const, updatedAt: NOW + 1 })) }, plan.revision);
    assert.equal(readModel.getItemAllocation({ version: "retail", baseItemId: ITEM }).data?.disposition, "SEND_HELLOMAGS", "explicit release removes the project reservation gate");

    store.createDemand({ baseItemId: GUILD_ITEM, requiredQuantity: 5 });
    store.createErpProject({ version: "retail", title: "Guild-only plan", needs: [{ stableId: "guild_need", kind: "ITEM_ID", resourceKey: String(GUILD_ITEM), label: "Guild resource", requiredQuantity: 1, sourceOwnerKey: "retail::guild::opaque-42" }], reservations: [{ stableId: "guild_hold", needId: "guild_need", sourceOwnerKey: "retail::guild::opaque-42", quantity: 1, status: "ACTIVE", createdAt: NOW, updatedAt: NOW }], workOrders: [] });
    assert.equal(readModel.getItemAllocation({ version: "retail", baseItemId: GUILD_ITEM }).data?.disposition, "SEND_HELLOMAGS", "guild reservations do not claim or reserve personal/account inventory");
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

// ---------------------------------------------------------------------------------------------
// Azeroth ERP Vertical Slice 3 — held-item identity and binding, end to end through real imports.
// Every scenario's demanded result is also checked against getAllocationReview (deep-equal parity).
// ---------------------------------------------------------------------------------------------

/** A row with an explicit item string and binding; `bound: undefined` renders as `?` (unknown). */
const heldRow = (ref: string, qty: number, bound: string | undefined, name = "Slice 3 fixture"): InventoryItemRecord => ({ itemRef: ref, name, qty, bound, vendorEachCopper: 100 });
const codesOf = (result: { reasons: { code: string }[] }) => result.reasons.map((r) => r.code);

function allocationWithParity(readModel: DashboardReadModel, baseItemId: number) {
  const result = readModel.getItemAllocation({ version: "retail", baseItemId }).data!;
  const reviewed = readModel.getAllocationReview({ version: "retail", demandedLimit: 100, unallocatedLimit: 100 }).data!.demanded.items.find((r) => r.commodity.baseItemId === baseItemId);
  assert.deepEqual(reviewed, result, `review demanded entry for ${baseItemId} deep-equals getItemAllocation`);
  return result;
}

test("Slice 3 scenario 1 — ordinary commodity: uniform full strings, bound=no, clean evidence is unchanged (RESOLVED, SEND_HELLOMAGS)", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830001;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 30, "no"), heldRow(`item:${ITEM}::::::::80:::::::::`, 5, "no")]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.deepEqual([result.confirmedAvailable, result.allocated, result.confirmedDeficit, result.confirmedSurplus], [35, 20, 0, 15]);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 });
    assert.deepEqual(result.confirmedBinding, { boundRowCount: 0, unboundRowCount: 2, unknownRowCount: 0 });
    assert.deepEqual(result.potentialItemStringIdentity, { class: "NONE_HELD", distinctItemStringCount: 0 });
  });
});

test("Slice 3 scenario 2 — rows differing only in viewer linkLevel/specID (78:1467 vs 85:253) are one item string with the same arithmetic", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830002;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::78:1467:::::::::`, 30, "no")]), bank: observedSection([heldRow(`item:${ITEM}::::::::85:253:::::::::`, 5, "no")]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 20 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.deepEqual([result.confirmedAvailable, result.allocated, result.confirmedDeficit, result.confirmedSurplus], [35, 20, 0, 15]);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 });
  });
});

test("Slice 3 scenario 3 — a bound Hearthstone under STOCK_TARGET 0: surplus 1 is reported, SEND_HELLOMAGS is withheld, nothing is unresolved", () => {
  withFixture((store, readModel, imp) => {
    const HEARTHSTONE = 6948;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${HEARTHSTONE}::::::::80:::::::::`, 1, "yes", "Hearthstone")]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: HEARTHSTONE, requiredQuantity: 0 });
    const result = allocationWithParity(readModel, HEARTHSTONE);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.equal(result.confirmedSurplus, 1);
    assert.equal(result.hasUnresolvedEvidence, false);
    assert.equal(result.disposition, "REQUIRES_REVIEW");
    assert.ok(codesOf(result).includes("BOUND_INVENTORY_PRESENT"));
    assert.ok(codesOf(result).includes("SALE_DISPOSITION_GATED_BY_BINDING"));
    assert.ok(!codesOf(result).includes("SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"));
    assert.ok(!codesOf(result).includes("SALE_PIPELINE_APPROVED"));
  });
});

test("Slice 3 scenario 4 — confirmed binding unknown gates a positive surplus without claiming bound inventory", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830004;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 10, undefined), heldRow(`item:${ITEM}::::::::80:::::::::`, 10, "no")]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 5 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.equal(result.confirmedSurplus, 15);
    assert.equal(result.hasUnresolvedEvidence, false);
    assert.equal(result.disposition, "REQUIRES_REVIEW");
    assert.deepEqual(result.confirmedBinding, { boundRowCount: 0, unboundRowCount: 1, unknownRowCount: 1 });
    assert.ok(codesOf(result).includes("BINDING_UNKNOWN_PRESENT"));
    assert.ok(codesOf(result).includes("SALE_DISPOSITION_GATED_BY_BINDING"));
    assert.ok(!codesOf(result).includes("BOUND_INVENTORY_PRESENT"));
  });
});

test("Slice 3 scenario 5 — binding facts without positive surplus keep the existing HOLD_ALLOCATED / NO_ACTION disposition", () => {
  withFixture((store, readModel, imp) => {
    const SHORT = 830005;
    const EXACT = 830006;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${SHORT}::::::::80:::::::::`, 2, "yes"), heldRow(`item:${EXACT}::::::::80:::::::::`, 3, undefined)]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: SHORT, requiredQuantity: 10 });
    store.createDemand({ baseItemId: EXACT, requiredQuantity: 3 });
    const short = allocationWithParity(readModel, SHORT);
    assert.equal(short.disposition, "HOLD_ALLOCATED");
    assert.ok(codesOf(short).includes("BOUND_INVENTORY_PRESENT"));
    assert.ok(!codesOf(short).includes("SALE_DISPOSITION_GATED_BY_BINDING"));
    const exact = allocationWithParity(readModel, EXACT);
    assert.equal(exact.disposition, "NO_ACTION");
    assert.ok(codesOf(exact).includes("BINDING_UNKNOWN_PRESENT"));
    assert.ok(!codesOf(exact).includes("SALE_DISPOSITION_GATED_BY_BINDING"));
  });
});

const NO_ARITHMETIC = ["allocated", "confirmedDeficit", "confirmedSurplus"];

test("Slice 3 scenario 6 — two distinct normalized full strings of one base item: BASE_ITEM_AGGREGATION_UNPROVEN with no arithmetic fields", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830007;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::1:10390`, 1, "no"), heldRow(`item:${ITEM}::::::::80:::::1:10391`, 1, "no")]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 1 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "BASE_ITEM_AGGREGATION_UNPROVEN");
    if (result.resolution !== "BASE_ITEM_AGGREGATION_UNPROVEN") return;
    assert.equal(result.confirmedQuantity, 2);
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 });
    for (const field of NO_ARITHMETIC) assert.ok(!(field in result), `${field} is structurally absent`);
    assert.equal(result.disposition, "REQUIRES_REVIEW");
    assert.deepEqual(codesOf(result), ["EXPLICIT_DEMAND_EXISTS", "ITEM_STRING_VARIANTS_PRESENT", "BASE_ITEM_AGGREGATION_UNPROVEN"]);
  });
});

test("Slice 3 scenario 7 — a bare item:<id> row with no full-string variants: ITEM_STRING_INCOMPLETE, BASE_ITEM_AGGREGATION_UNPROVEN, no arithmetic fields", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830008;
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 4, "no"), heldRow(`item:${ITEM}`, 4, "no")]), bank: observedSection([]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 1 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "BASE_ITEM_AGGREGATION_UNPROVEN");
    if (result.resolution !== "BASE_ITEM_AGGREGATION_UNPROVEN") return;
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount: 1 });
    assert.equal(result.confirmedQuantity, 8);
    for (const field of NO_ARITHMETIC) assert.ok(!(field in result), `${field} is structurally absent`);
    assert.ok(codesOf(result).includes("ITEM_STRING_INCOMPLETE"));
  });
});

test("Slice 3 scenario 8 — LAST_SEEN variants and bound LAST_SEEN rows are reported but never gate a uniform confirmed result", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830009;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 10, "no")]),
      bank: observedSection([]),
      warband: warbandSection("LAST_SEEN", [heldRow(`item:${ITEM}::::::::80:::::1:500`, 3, "yes"), heldRow(`item:${ITEM}::::::::80:::::1:501`, 3, "yes")]),
    });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 4 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.deepEqual([result.allocated, result.confirmedSurplus], [4, 6]);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 });
    assert.deepEqual(result.potentialItemStringIdentity, { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 });
    assert.deepEqual(result.potentialBinding, { boundRowCount: 2, unboundRowCount: 0, unknownRowCount: 0 });
    for (const code of ["ITEM_STRING_VARIANTS_PRESENT", "BOUND_INVENTORY_PRESENT", "SALE_DISPOSITION_GATED_BY_BINDING"]) assert.ok(!codesOf(result).includes(code), code);
  });
});

test("Slice 3 scenario 9 — unknown storage plus confirmed binding: both gates' reasons appear and stay distinct", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830010;
    // Bank omitted -> UNKNOWN storage.
    imp({ name: "Anchor", generated: T, bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 9, "yes")]), warband: warbandSection("OBSERVED", []) });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 2 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.equal(result.confirmedSurplus, 7);
    assert.equal(result.hasUnresolvedEvidence, true);
    assert.deepEqual(result.unresolvedScopes, ["character-bank"]);
    assert.equal(result.disposition, "REQUIRES_REVIEW");
    for (const code of ["UNRESOLVED_STORAGE_PRESENT", "BOUND_INVENTORY_PRESENT", "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE", "SALE_DISPOSITION_GATED_BY_BINDING"]) assert.ok(codesOf(result).includes(code), code);
    assert.ok(!codesOf(result).includes("BINDING_UNKNOWN_PRESENT"));
    const storage = result.reasons.find((r) => r.code === "UNRESOLVED_STORAGE_PRESENT")!;
    assert.doesNotMatch(storage.detail ?? "", /bind/i, "binding is never described as unknown storage");
  });
});

test("Slice 3 scenario 10 — guild-only variants and bound rows never touch account facets, arithmetic, or disposition", () => {
  withFixture((store, readModel, imp) => {
    const ITEM = 830011;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([heldRow(`item:${ITEM}::::::::80:::::::::`, 10, "no")]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
      guild: guildSection("gclub-s3", [heldRow(`item:${ITEM}::::::::80:::::1:1`, 50, "yes"), heldRow(`item:${ITEM}`, 50, undefined)]),
    });
    store.createDemand({ baseItemId: ITEM, requiredQuantity: 4 });
    const result = allocationWithParity(readModel, ITEM);
    assert.equal(result.resolution, "RESOLVED");
    if (result.resolution !== "RESOLVED") return;
    assert.deepEqual([result.confirmedAvailable, result.confirmedSurplus], [10, 6]);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
    assert.deepEqual(result.confirmedItemStringIdentity, { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 });
    assert.deepEqual(result.confirmedBinding, { boundRowCount: 0, unboundRowCount: 1, unknownRowCount: 0 });
    assert.deepEqual(result.potentialBinding, { boundRowCount: 0, unboundRowCount: 0, unknownRowCount: 0 });
    assert.equal(result.guildContext[0]?.quantity, 100, "guild evidence stays contextual");
    assert.ok(codesOf(result).includes("GUILD_EVIDENCE_EXCLUDED"));
  });
});

test("Slice 3 scenario 11 — no safe-list: differing modifier 28 or modifier 38 values are ITEM_STRING_VARIANTS", () => {
  withFixture((store, readModel, imp) => {
    const MOD28 = 830012;
    const MOD38 = 830013;
    imp({
      name: "Anchor",
      generated: T,
      bags: observedSection([heldRow(`item:${MOD28}::::::::80::::::1:28:2000`, 1, "no"), heldRow(`item:${MOD28}::::::::80::::::1:28:2001`, 1, "no"), heldRow(`item:${MOD38}::::::::80::::::1:38:5`, 1, "no")]),
      bank: observedSection([heldRow(`item:${MOD38}::::::::80::::::1:38:6`, 1, "no")]),
      warband: warbandSection("OBSERVED", []),
    });
    store.createDemand({ baseItemId: MOD28, requiredQuantity: 1 });
    store.createDemand({ baseItemId: MOD38, requiredQuantity: 1 });
    for (const id of [MOD28, MOD38]) {
      const result = allocationWithParity(readModel, id);
      assert.equal(result.resolution, "BASE_ITEM_AGGREGATION_UNPROVEN", `${id}`);
      assert.equal(result.confirmedItemStringIdentity?.class, "ITEM_STRING_VARIANTS");
    }
  });
});
