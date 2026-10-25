import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DashboardReadModel } from "../src/readModel.ts";
import { FOREVER_MAIL_RULESET } from "../src/mailFlavorPolicy.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { classifyMailItem } from "../src/mailItemClassification.ts";

const scenario = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/forever/mail-routing-dev-anonymized.json", import.meta.url)), "utf8")).snapshot541Scenario;
const NOW = 1_792_724_851;

function itemFact(itemID: number, name: string, itemType: string, itemSubType: string, equipLocation: string, equippable: boolean) {
  const itemRef = `item:${itemID}::::::::12:1490:::::::::`;
  const observed = (value: string | number | boolean) => ({ state: "OBSERVED", type: typeof value, value });
  return { itemID, itemString: itemRef, itemInfoInstant: {
    api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", input: { itemString: itemRef },
    returns: [itemID, itemType, itemSubType, equipLocation, 0, 0, 0].map((value) => ({ observation: observed(value) })),
  }, isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", input: { itemString: itemRef }, observedAt: NOW, returns: [{ observation: observed(equippable) }] } };
}

test("anonymized snapshot-541 mail plan keeps holder reagents and routes containers before gear", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const holderName = "Holder";
    const realm = "Classic Beta PvE";
    const holderRef = (itemId: number) => `item:${itemId}::::::::12:1490:::::::::`;
    const items = [
      ...scenario.materials.map((item: { itemId: number; name: string }) => ({ itemRef: holderRef(item.itemId), name: item.name, qty: 2, bound: false })),
      ...scenario.containers.map((itemId: number) => ({ itemRef: holderRef(itemId), name: itemId === 4496 ? "Small Brown Pouch" : "Small Green Pouch", qty: 1, bound: false })),
    ];
    const professionRecipeData = {
      formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 3 },
      professions: scenario.materials.map((material: { itemId: number; usedBy: string }, index: number) => ({
        baseSkillLineID: 1 + index, skillLineID: 1 + index, professionName: material.usedBy, evidence: "OBSERVED", observedAt: NOW - 60,
        recipes: [{ recipeID: 100 + index, name: `Anonymized ${material.usedBy} recipe`, evidence: "OBSERVED", learned: false, learnedState: "OBSERVED_FALSE", reagentSlots: [{ slotIndex: 1, required: true, quantityRequired: 1, reagents: [{ itemID: material.itemId }] }] }],
      })),
    };
    const text = buildWowSyncExport({ generatedAt: NOW, character: { name: holderName, realm, class: "Warlock", race: "Gnome", faction: "Alliance", level: 12, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70532", interface: "16001" }, professions: { entries: ["Tailoring", "Enchanting", "Cooking"].map((name) => ({ name, skill: 1, maxSkill: 75 })) }, bags: { containers: [{ id: 0, capacity: 16, free: 9, items }] }, bank: { unknown: true } });
    const sourceGuid = "Player-1-ANON-HOLDER";
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 60, character: { name: holderName, realm, class: "Warlock", race: "Gnome", faction: "Alliance", level: 12, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70532", interface: "16001" }, professions: { entries: ["Tailoring", "Enchanting", "Cooking"].map((name) => ({ name, skill: 1, maxSkill: 75 })) }, bags: { containers: [] }, bank: { unknown: true } }), { foreverGearObservation: {
      clientProfile: "Forever:1.60.1:70532:16001", name: holderName, realm, generatedAt: NOW - 60, sourceCharacterGuid: sourceGuid,
      equipment: { observedAt: NOW - 60, completeness: "complete", data: { slots: {} } },
      bags: { observedAt: NOW - 60, completeness: "complete", data: { containers: [] } }, bank: { observedAt: NOW - 60, completeness: "unknown", data: {} },
      professionRecipes: { status: { state: "OBSERVED", completeness: "partial", observedAt: NOW - 60 }, completeness: "partial", observedAt: NOW - 60, data: professionRecipeData },
    } });
    store.importSnapshot(text, { foreverGearObservation: {
      clientProfile: "Forever:1.60.1:70532:16001", name: holderName, realm, generatedAt: NOW, sourceCharacterGuid: "Player-1-ANON-HOLDER",
      equipment: { observedAt: NOW, completeness: "complete", data: { slots: {} } },
      bags: { observedAt: NOW, completeness: "complete", data: { containers: [{ id: 0, slots: Object.fromEntries(items.map((item: { itemRef: string; name: string; qty: number; bound: boolean }, index: number) => [String(index + 1), { itemID: Number(item.itemRef.match(/^item:(\d+)/)?.[1]), itemString: item.itemRef, name: item.name, count: item.qty, bound: item.bound }])) }] } },
      bank: { observedAt: NOW, completeness: "unknown", data: {} },
      itemEvidence: { observedAt: NOW, completeness: "complete", source: "anonymized snapshot-541 regression fixture", data: { sourceSections: { bags: { observedAt: NOW, state: "complete" } }, items: [
        ...scenario.materials.map((item: { itemId: number; name: string }) => itemFact(item.itemId, item.name, "Trade Goods", item.itemId === 2589 || item.itemId === 2320 ? "Cloth" : "Enchanting", "INVTYPE_NON_EQUIP_IGNORE", false)),
        ...scenario.containers.map((itemId: number) => itemFact(itemId, itemId === 4496 ? "Small Brown Pouch" : "Small Green Pouch", "Container", "Bag", "INVTYPE_BAG", true)),
      ] } },
    } });
    for (const [name, bagSlots] of [["Alt A", scenario.eligibleAltBagSlots[0]], ["Alt B", scenario.eligibleAltBagSlots[1]]] as const) {
      store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name, realm, class: "Warlock", faction: "Alliance", level: 8, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70532", interface: "16001" }, professions: { entries: [] }, bags: { containers: [{ id: 0, capacity: bagSlots, free: bagSlots }] }, bank: { unknown: true } }), { foreverGearObservation: {
        clientProfile: "Forever:1.60.1:70532:16001", name, realm, generatedAt: NOW - 20, sourceCharacterGuid: `Player-1-ANON-${name.replaceAll(" ", "")}`,
        equipment: { observedAt: NOW - 20, completeness: "complete", data: { slots: {} } },
        bags: { observedAt: NOW - 20, completeness: "complete", data: { containers: [{ id: 0, slots: {} }] } },
        bank: { observedAt: NOW - 20, completeness: "unknown", data: {} },
      } });
    }
    const result = new DashboardReadModel(store, () => NOW).getForeverMailPlan({ version: "forever", name: holderName, realm });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND" || !result.value.data || !("pouchMail" in result.value.data)) throw new Error("Expected a Forever mail plan");
    const plan = result.value.data;
    assert.equal(plan.ruleset, FOREVER_MAIL_RULESET);
    assert.deepEqual(plan.pouchMail.map((row) => [(row.item as { itemRef?: string }).itemRef, row.disposition, (row.recipient as { name?: string }).name]), [
      [holderRef(4496), "POUCH_TO_ALT", "Alt A"], [holderRef(5572), "POUCH_TO_ALT", "Alt A"],
    ]);
    assert.equal(plan.mail.length, 0, "containers never enter equipment-fit mail");
    for (const { itemId, usedBy } of scenario.materials as Array<{ itemId: number; usedBy: string }>) {
      assert.ok(plan.keep.some((row) => (row.item as { itemRef?: string }).itemRef === holderRef(itemId) && String(row.reason).includes(`used by your own ${usedBy}`)));
      assert.ok(!plan.sale.some((row) => (row.item as { itemRef?: string }).itemRef === holderRef(itemId)), "holder profession use suppresses sale");
    }
    assert.ok(!plan.unknownReasons.some((reason) => /before selling any no-recipient item/i.test(reason)));
  } finally { store.close(); }
});

test("Hallo Forever fixture uses the shared version-scoped item safeguards", () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/forever/copilot-hallo-pvp2.import.json", import.meta.url)), "utf8"));
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(fixture.text, { foreverGearObservation: fixture.foreverGearObservation } as any);
    const read = new DashboardReadModel(store, () => fixture.foreverGearObservation.generatedAt + 1);
    const plan = read.getForeverMailPlan({ version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" });
    assert.equal(plan.status, "FOUND");
    if (plan.status !== "FOUND" || !plan.value.data) throw new Error("Expected Hallo Forever mail plan");
    assert.equal(plan.value.data.version, "forever");
    assert.equal(classifyMailItem({ version: "forever", bound: "BOUND" }).action, "KEEP");
    assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", name: "Linen Cloth", ownRecipeUseNames: ["linen-cloth"] }).action, "KEEP");
    assert.equal(classifyMailItem({ version: "forever", itemId: 117, bound: "UNBOUND" }).action, "KEEP");
    assert.equal(classifyMailItem({ version: "forever", itemId: 5512, bound: "UNBOUND" }).reason, "conjured, can't be mailed");
    assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", equippable: true }).reason, "possible upgrade, unverified");
  } finally { store.close(); }
});
