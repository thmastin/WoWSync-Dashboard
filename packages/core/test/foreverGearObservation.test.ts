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
