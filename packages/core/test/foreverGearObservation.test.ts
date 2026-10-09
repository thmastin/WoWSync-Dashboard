import test from "node:test";
import assert from "node:assert/strict";
import { buildForeverGearObservation, normalizeForeverStructuredObservation, type ForeverStructuredObservation } from "../src/foreverGearObservation.ts";
import type { EquipmentSection, InventorySection } from "../src/types.ts";

const equipment: EquipmentSection = { status: { state: "OBSERVED", observedAt: 100 }, slots: [{ slot: 16, slotName: "Main Hand", empty: false, itemRef: "item:123:0:0:0:0:0:0:0", name: "Test Blade" }] };
const bags: InventorySection = { status: { state: "OBSERVED", observedAt: 101 }, containers: [], itemsKnownEmpty: false, items: [{ itemRef: "item:123:0:0:0:0:0:0:0", name: "Test Blade", qty: 1 }, { itemRef: "item:456:0:0:0:0:0:0:0:77:0:0:0", name: "Variant", qty: 2 }] };
const bank: InventorySection = { status: { state: "UNKNOWN", reason: "Not captured" }, containers: [], itemsKnownEmpty: false, items: [] };
const identity = { version: "forever" as const, identityKey: "forever::hallo::hero", name: "Hero", realm: "Hallo" };
const sidecar: ForeverStructuredObservation = { clientProfile: "Forever:1.60.1:70291:16001", name: "Hero", realm: "Hallo", generatedAt: 99, sourceCharacterGuid: "Player-1-HERO", equipment: { observedAt: 100, completeness: "complete", data: { slots: { "16": { itemID: 999, itemString: "item:999:4:5", name: "Structured Blade", itemLevel: 2 } } } }, bags: { observedAt: 101, completeness: "partial", data: { containers: [{ id: 0, slots: { "1": { itemID: 999, itemString: "item:999:4:5", count: 2, name: "Structured Variant" } } }] } }, bank: { observedAt: 101, completeness: "unknown", reason: "not visited", data: {} }, itemMetadata: {} };

test("Forever structured sidecar is isolated by version, identity, profile, and export timestamp", () => {
  assert.ok(normalizeForeverStructuredObservation(sidecar, "forever", "Hero", "Hallo", 99));
  assert.equal(normalizeForeverStructuredObservation(sidecar, "retail", "Hero", "Hallo", 99), undefined);
  assert.equal(normalizeForeverStructuredObservation(sidecar, "forever", "Other", "Hallo", 99), undefined);
  assert.equal(normalizeForeverStructuredObservation(sidecar, "forever", "Hero", "Hallo", 98), undefined);
  assert.equal(normalizeForeverStructuredObservation({ ...sidecar, clientProfile: "Retail" }, "forever", "Hero", "Hallo", 99), undefined);
});

test("Forever observation preserves exact variants and keeps evaluation claims UNKNOWN", () => {
  const structured = normalizeForeverStructuredObservation(sidecar, "forever", "Hero", "Hallo", 99);
  const view = buildForeverGearObservation({ identity, snapshotId: 1, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured, now: 110 });
  assert.equal(view.identity.identityKey, identity.identityKey);
  assert.equal(view.equipment.items[0]?.itemRef, "item:999:4:5", "structured items stay paired with their own observedAt timestamp even if text differs");
  assert.equal(view.equipment.observedAt, 100);
  assert.equal(view.equipment.freshness, "recent");
  assert.equal(view.equipment.items[0]?.provenance, "OBSERVED");
  assert.equal(view.carried?.items?.[0]?.itemRef, "item:999:4:5", "structured bag rows stay paired with the structured bag timestamp");
  assert.equal(view.carried?.items?.[0]?.quantity, 2);
  assert.equal(view.evaluationCandidates.state, "UNKNOWN");
  assert.equal(view.evaluationCandidates.items.length, 0);
  assert.deepEqual(view.unknowns, { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" });
  assert.equal(view.bank.state, "UNKNOWN");
  assert.match(view.bank.reason!, /not empty/);
});

test("missing and stale structured observations remain explicit", () => {
  const missing = buildForeverGearObservation({ identity, snapshotId: 2, importedAt: 1000, equipment, bags, bank, now: 10_000_000 });
  assert.equal(missing.equipment.source, "WOWSYNC v1 equipment");
  assert.equal(missing.equipment.freshness, "stale");
  assert.equal(missing.metadataSource, "UNKNOWN");
  assert.equal(missing.evaluationCandidates.state, "UNKNOWN");
});

test("equipment slots without item identifiers remain UNKNOWN and partial identifiers stay visible", () => {
  const view = buildForeverGearObservation({ identity, snapshotId: 3, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured: { ...sidecar, equipment: { observedAt: 103, completeness: "partial", data: { slots: { "1": {}, "16": { itemID: 321, name: "Partial only" } } } } }, now: 110 });
  assert.equal(view.equipment.items[0]?.provenance, "UNKNOWN");
  assert.equal(view.equipment.items[0]?.itemRef, undefined);
  assert.equal(view.equipment.items[1]?.itemRef, "item:321");
  assert.equal(view.equipment.items[1]?.itemIdentity, "PARTIAL");
});

test("structured bag slot arrays preserve the observed one-based WoW slot indexes", () => {
  const view = buildForeverGearObservation({ identity, snapshotId: 4, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured: { ...sidecar, bags: { observedAt: 104, completeness: "complete", data: { containers: [{ id: 0, slots: [{ itemID: 111, itemString: "item:111:0", count: 3 }, { itemID: 112, itemString: "item:112:7", count: 1 }] }] } } }, now: 110 });
  assert.deepEqual(view.carried.items?.map((item) => ({ slot: item.slot, itemRef: item.itemRef, quantity: item.quantity })), [
    { slot: 1, itemRef: "item:111:0", quantity: 3 },
    { slot: 2, itemRef: "item:112:7", quantity: 1 },
  ]);
});

function itemFact(itemString: string, itemID: number, equipLocation: string, equippable: boolean) {
  const observed = (value: string | number | boolean) => ({ state: "OBSERVED", type: typeof value, value });
  return { itemString, itemID,
    itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", returns: [itemID, "Armor", "Leather", equipLocation].map((value) => ({ observation: observed(value) })) },
    isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", returns: [{ observation: observed(equippable) }] },
  };
}

test("Forever item API evidence exposes potential candidates without claiming eligibility or upgrades", () => {
  const itemString = "item:999:4:5";
  const structured: ForeverStructuredObservation = { ...sidecar,
    bags: { observedAt: 101, completeness: "complete", data: { containers: [{ id: 0, slots: { "1": { itemID: 999, itemString, count: 1 } } }] } },
    itemEvidence: { observedAt: 105, completeness: "complete", source: "C_Item evidence", data: { sourceSections: { bags: { observedAt: 101, state: "complete" } }, items: [itemFact(itemString, 999, "INVTYPE_CHEST", true)] } },
  };
  const view = buildForeverGearObservation({ identity, snapshotId: 5, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured, now: 110 });
  assert.equal(view.evaluationCandidates.state, "OBSERVED");
  assert.equal(view.evaluationCandidates.items.length, 1);
  assert.equal(view.evaluationCandidates.items[0]?.itemRef, itemString);
  assert.equal(view.evaluationCandidates.items[0]?.equipLocation, "INVTYPE_CHEST");
  assert.equal(view.evaluationCandidates.items[0]?.classification, "POTENTIAL_EQUIPMENT");
  assert.deepEqual(view.evaluationCandidates.unknowns, { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" });
  assert.match(view.evaluationCandidates.items[0]?.reason ?? "", /does not establish character eligibility/);
});

test("candidate classification matches exact item variants and leaves missing rows partial", () => {
  const firstVariant = "item:999:4:5";
  const otherVariant = "item:999:4:5:6";
  const structured: ForeverStructuredObservation = { ...sidecar,
    bags: { observedAt: 101, completeness: "complete", data: { containers: [{ id: 0, slots: {
      "1": { itemID: 999, itemString: firstVariant, count: 1 },
      "2": { itemID: 999, itemString: otherVariant, count: 2 },
    } }] } },
    itemEvidence: { observedAt: 105, completeness: "complete", source: "C_Item evidence", data: { sourceSections: { bags: { observedAt: 101, state: "complete" } }, items: [itemFact(firstVariant, 999, "INVTYPE_CHEST", true)] } },
  };
  const view = buildForeverGearObservation({ identity, snapshotId: 6, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured, now: 110 });
  assert.equal(view.evaluationCandidates.state, "PARTIAL");
  assert.deepEqual(view.evaluationCandidates.items.map((item) => item.itemRef), [firstVariant]);
  assert.match(view.evaluationCandidates.reason, /not ruled out/);
});

test("uncached or stale item facts never become current candidate exclusions", () => {
  const uncached = { ...itemFact("item:999:4:5", 999, "INVTYPE_CHEST", true),
    itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "API_ERROR", returns: [] },
  };
  const missingFact: ForeverStructuredObservation = { ...sidecar,
    itemEvidence: { observedAt: 105, completeness: "complete", source: "C_Item evidence", data: { sourceSections: { bags: { observedAt: 101, state: "complete" } }, items: [uncached] } },
  };
  const unknown = buildForeverGearObservation({ identity, snapshotId: 7, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured: missingFact, now: 110 });
  assert.equal(unknown.evaluationCandidates.state, "PARTIAL", "the source inventory itself is partial even when no API fact is usable");
  assert.equal(unknown.evaluationCandidates.items.length, 0);
  const stale = buildForeverGearObservation({ identity, snapshotId: 8, generatedAt: 99, importedAt: 102, equipment, bags, bank,
    structured: { ...sidecar, itemEvidence: { observedAt: 1, completeness: "complete", source: "Old C_Item evidence", data: { sourceSections: { bags: { observedAt: 1, state: "complete" } }, items: [itemFact("item:999:4:5", 999, "INVTYPE_CHEST", true)] } } }, now: 10_000_000 });
  assert.equal(stale.evaluationCandidates.state, "LAST_SEEN");
  assert.equal(stale.evaluationCandidates.items[0]?.provenance, "LAST_SEEN");
  assert.equal(stale.bank.state, "UNKNOWN");
});

test("partial or stale carried-source timestamps cannot be upgraded by a fresh item API sample", () => {
  const itemString = "item:999:4:5";
  const facts = [itemFact(itemString, 999, "INVTYPE_CHEST", true)];
  const partial = buildForeverGearObservation({ identity, snapshotId: 9, generatedAt: 99, importedAt: 102, equipment, bags, bank,
    structured: { ...sidecar, itemEvidence: { observedAt: 109, completeness: "complete", source: "fresh API, partial source", data: { sourceSections: { bags: { observedAt: 101, state: "partial" } }, items: facts } } }, now: 110 });
  assert.equal(partial.evaluationCandidates.state, "PARTIAL");
  assert.equal(partial.evaluationCandidates.items[0]?.provenance, "DERIVED", "an exact row remains usable evidence while coverage is partial");
  const old = buildForeverGearObservation({ identity, snapshotId: 10, generatedAt: 99, importedAt: 102, equipment, bags, bank,
    structured: { ...sidecar, itemEvidence: { observedAt: 10_000_000, completeness: "complete", source: "fresh API, old source", data: { sourceSections: { bags: { observedAt: 1, state: "complete" } }, items: facts } } }, now: 10_000_000 });
  assert.equal(old.evaluationCandidates.state, "LAST_SEEN");
  assert.equal(old.evaluationCandidates.freshness, "recent", "the fresh API sample cannot refresh its old inventory source");
  assert.equal(old.evaluationCandidates.items[0]?.provenance, "LAST_SEEN");
});

test("partial equipment item facts do not downgrade complete carried-candidate coverage", () => {
  const itemString = "item:999:4:5";
  const structured: ForeverStructuredObservation = { ...sidecar,
    bags: { observedAt: 101, completeness: "complete", data: { containers: [{ id: 0, slots: { "1": { itemID: 999, itemString, count: 1 } } }] } },
    itemEvidence: { observedAt: 105, completeness: "partial", source: "equipment source partial; carried facts complete", data: {
      sourceSections: { equipment: { observedAt: 100, state: "partial" }, bags: { observedAt: 101, state: "complete" } },
      items: [itemFact(itemString, 999, "INVTYPE_CHEST", true)],
    } },
  };
  const view = buildForeverGearObservation({ identity, snapshotId: 11, generatedAt: 99, importedAt: 102, equipment, bags, bank, structured, now: 110 });
  assert.equal(view.evaluationCandidates.state, "OBSERVED");
  assert.equal(view.evaluationCandidates.items[0]?.itemRef, itemString);
  assert.match(view.evaluationCandidates.reason, /Every carried row has matching/);
  assert.deepEqual(view.evaluationCandidates.unknowns, { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" });
});
