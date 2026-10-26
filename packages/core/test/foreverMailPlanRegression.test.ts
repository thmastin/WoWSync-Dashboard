import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DashboardReadModel } from "../src/readModel.ts";
import { FOREVER_MAIL_RULESET } from "../src/mailFlavorPolicy.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { classifyMailItem } from "../src/mailItemClassification.ts";
import { recipeLearningRequirement } from "../src/recipeLearningRequirements.ts";
import { bagSpaceIsTight, DEFAULT_MAIL_BAG_SPACE_CONFIG, planCookingMaterial, planFoodDrink, rankFoodDrinkRows } from "../src/foodDrinkPlanning.ts";

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
      { itemRef: holderRef(9301), name: "Tier 5 food fixture", qty: 2, bound: false, foodKind: "FOOD", requiredLevel: 5 },
      { itemRef: holderRef(9302), name: "Tier 10 food fixture", qty: 2, bound: false, foodKind: "FOOD", requiredLevel: 10 },
      { itemRef: holderRef(9303), name: "Well Fed buff food fixture", qty: 3, bound: false, foodKind: "BUFF_FOOD", requiredLevel: 8, foodStackSize: 1, spellText: "Well Fed" },
      { itemRef: holderRef(9304), name: "Future food fixture", qty: 1, bound: false, foodKind: "FOOD", requiredLevel: 15 },
      { itemRef: holderRef(9305), name: "Raw cooking material fixture", qty: 6, bound: false },
    ];
    const professionRecipeData = {
      formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 4 },
      professions: [...scenario.materials.map((material: { itemId: number; usedBy: string }, index: number) => ({
        baseSkillLineID: 1 + index, skillLineID: 1 + index, professionName: material.usedBy, evidence: "OBSERVED", observedAt: NOW - 60,
        recipes: [{ recipeID: 100 + index, name: `Anonymized ${material.usedBy} recipe`, evidence: "OBSERVED", learned: false, learnedState: "OBSERVED_FALSE", reagentSlots: [{ slotIndex: 1, required: true, quantityRequired: 1, reagents: [{ itemID: material.itemId }] }] }],
      })), { baseSkillLineID: 185, skillLineID: 185, professionName: "Cooking", evidence: "OBSERVED", observedAt: NOW - 60,
        recipes: [{ recipeID: 93050, name: "Known cooking material recipe", evidence: "OBSERVED", learned: true, learnedState: "OBSERVED_TRUE", requiredSkill: 15, reagentSlots: [{ slotIndex: 1, required: true, quantityRequired: 2, reagents: [{ itemID: 9305, name: "Raw cooking material fixture" }] }] }] }],
    };
    const text = buildWowSyncExport({ generatedAt: NOW, character: { name: holderName, realm, class: "Warlock", race: "Gnome", faction: "Alliance", level: 12, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70532", interface: "16001" }, professions: { entries: ["Tailoring", "Enchanting", "Cooking"].map((name) => ({ name, skill: 1, maxSkill: 75 })) }, bags: { containers: [{ id: 0, capacity: items.length, free: 0, items }] }, bank: { unknown: true } });
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
      bags: { observedAt: NOW, completeness: "complete", data: { containers: [{ id: 0, slots: Object.fromEntries(items.map((item: any, index: number) => [String(index + 1), { itemID: Number(item.itemRef.match(/^item:(\d+)/)?.[1]), itemString: item.itemRef, name: item.name, count: item.qty, bound: item.bound, ...(item.foodKind ? { itemMetadataState: "OBSERVED", classID: 0, subClassID: 5, equipLoc: "INVTYPE_NON_EQUIP_IGNORE", requiredLevel: item.requiredLevel, foodKind: item.foodKind, ...(item.foodStackSize ? { foodStackSize: item.foodStackSize } : {}), ...(item.spellText ? { spellText: item.spellText } : {}) } : item.itemRef.includes(":9305") ? { itemMetadataState: "OBSERVED", classID: 7, subClassID: 8, equipLoc: "INVTYPE_NON_EQUIP_IGNORE" } : {}) }])) }] } },
      bank: { observedAt: NOW, completeness: "unknown", data: {} },
      itemEvidence: { observedAt: NOW, completeness: "complete", source: "anonymized snapshot-541 regression fixture", data: { sourceSections: { bags: { observedAt: NOW, state: "complete" } }, items: [
        ...scenario.materials.map((item: { itemId: number; name: string }) => itemFact(item.itemId, item.name, "Trade Goods", item.itemId === 2589 || item.itemId === 2320 ? "Cloth" : "Enchanting", "INVTYPE_NON_EQUIP_IGNORE", false)),
        itemFact(9305, "Raw cooking material fixture", "Trade Goods", "Cooking", "INVTYPE_NON_EQUIP_IGNORE", false),
        ...scenario.containers.map((itemId: number) => itemFact(itemId, itemId === 4496 ? "Small Brown Pouch" : "Small Green Pouch", "Container", "Bag", "INVTYPE_BAG", true)),
        ...items.filter((item: any) => item.foodKind).map((item: any) => itemFact(Number(item.itemRef.match(/^item:(\d+)/)?.[1]), item.name, "Consumable", "Food & Drink", "INVTYPE_NON_EQUIP_IGNORE", false)),
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
    const auctionCharacter = store.listCharacters("forever").find((row) => row.name === "Alt A")!;
    store.setMailPlanSettings({ accountId: "default", version: "forever", realm, faction: "Alliance", auctionCharacterIdentityKey: auctionCharacter.identityKey, updatedAt: NOW, provenance: "USER_CONFIGURED" });
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
    assert.ok(plan.keep.some((row: any) => row.item?.itemRef === holderRef(9302) && /usable tier 10/.test(row.reason)));
    assert.ok(plan.sale.some((row: any) => row.item?.itemRef === holderRef(9301) && /lower tier and bags are tight/.test(row.reason)));
    assert.ok(plan.keep.some((row: any) => row.item?.itemRef === holderRef(9303) && row.keepQuantity === 1 && /quantity 3/.test(row.reason)));
    assert.ok(plan.keep.some((row: any) => row.item?.itemRef === holderRef(9305) && /Next Cooking goal is UNKNOWN/.test(row.reason) && /quantity 6/.test(row.reason)), "partial recipe coverage preserves the material instead of treating the unknown goal as zero");
    assert.ok(plan.materialMail.some((row: any) => row.item?.itemRef === holderRef(9304) && row.disposition === "MAIL_TO_AUCTION_CHARACTER"));
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
    assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", equippable: true }).reason, "Observed equipment item; upgrade suitability is UNKNOWN.");
    assert.equal(classifyMailItem({ version: "forever", bound: "BOUND", classCanEquip: false, vendorEachCopper: 12 }).action, "VENDOR");
    assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", classCanEquip: false }).action, "ROUTE");
    const recipeRequirement = recipeLearningRequirement("forever", 2889);
    assert.equal(recipeRequirement?.requiredSkill, 25);
    assert.equal(classifyMailItem({ version: "forever", itemId: 2889, bound: "UNBOUND", recipeItem: { professionState: "KNOWN", hasProfession: true, profession: "Cooking", recipeName: "Beer Basted Boar Ribs", requiredSkill: 25, holderSkill: 8, learnedState: "UNKNOWN" } }).reason, "learn at Cooking 25 (now 8)");
    const bags = read.getCharacterBags({ version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") assert.ok((bags.value.data?.items?.length ?? 0) > 0, "Hallo fixture bag rows stay available in the Forever read model");
  } finally { store.close(); }
});

test("shared bag-space cooking goals preserve UNKNOWN and flag only verified excess", () => {
  assert.equal(bagSpaceIsTight(8, 16), true, "16-slot bag uses the minimum threshold of 8");
  assert.equal(bagSpaceIsTight(9, 16), false);
  assert.equal(bagSpaceIsTight(10, 100), true, "100-slot bag uses 10 percent");
  assert.equal(bagSpaceIsTight(11, 100), false);
  assert.equal(bagSpaceIsTight(undefined, 16), false, "UNKNOWN free slots are not treated as zero");
  assert.equal(bagSpaceIsTight(8, undefined), false, "UNKNOWN total slots leave the rule off");
  assert.equal(bagSpaceIsTight(6, 16, { ...DEFAULT_MAIL_BAG_SPACE_CONFIG, lowFreeSlotThreshold: 6 }), true);

  const recipes = [
    { name: "Roasted Boar Meat", requiredSkill: 15, evidence: "OBSERVED" as const, learnedState: "OBSERVED_TRUE" as const, reagents: [{ itemId: 2679, count: 2 }] },
    { name: "Charred Wolf Meat", requiredSkill: 25, evidence: "OBSERVED" as const, learnedState: "OBSERVED_TRUE" as const, reagents: [{ itemId: 2672, count: 3 }] },
  ];
  const known = planCookingMaterial({ itemId: 2679, itemName: "Boar Ribs", quantity: 7, cookingSkill: 10, professionState: "OBSERVED", recipeCompleteness: "complete", recipes });
  assert.deepEqual(known && [known.state, known.keepQuantity, known.excessQuantity, known.nextRecipe], ["KNOWN", 2, 5, "Roasted Boar Meat"]);
  const cookFirst = classifyMailItem({ version: "forever", bound: "UNBOUND", cookingMaterialPlan: known, cookingFireAvailable: true });
  assert.equal(cookFirst.action, "KEEP");
  assert.equal("excessQuantity" in cookFirst ? cookFirst.excessQuantity : undefined, 5);
  assert.match(cookFirst.reason ?? "", /COOK_FIRST/);
  const routeExcess = classifyMailItem({ version: "forever", bound: "UNBOUND", cookingMaterialPlan: known, cookingExcessDisposition: "MAIL_TO_AUCTION_CHARACTER" });
  assert.equal(routeExcess.action, "KEEP", "the needed quantity stays on the holder while excess is routed");
  assert.equal("excessDisposition" in routeExcess ? routeExcess.excessDisposition : undefined, "MAIL_TO_AUCTION_CHARACTER");
  const unknown = planCookingMaterial({ itemId: 2679, itemName: "Boar Ribs", quantity: 7, professionState: "OBSERVED", recipeCompleteness: "partial", recipes });
  assert.equal(unknown?.state, "UNKNOWN");
  assert.match(unknown?.reason ?? "", /quantity 7/);
});

test("shared food and drink rules rank observed tiers and preserve unknowns", () => {
  const high = planFoodDrink({ kind: "FOOD", requiredLevel: 10, quantity: 2 }, 12, false);
  const low = planFoodDrink({ kind: "FOOD", requiredLevel: 5, quantity: 4 }, 12, true, 10);
  const buff = planFoodDrink({ kind: "BUFF_FOOD", requiredLevel: 8, quantity: 3, stackSize: 1, evidence: "TOOLTIP" }, 12, true);
  const future = planFoodDrink({ kind: "DRINK", requiredLevel: 15, quantity: 1 }, 12, false);
  const unknown = planFoodDrink({ kind: "UNKNOWN", quantity: 7 }, 12, false);
  assert.equal(high.action, "KEEP");
  assert.equal(low.action, "VENDOR");
  assert.equal(buff.keepQuantity, 1);
  assert.equal(future.action, "MAIL_TO_AUCTION_CHARACTER");
  assert.equal(unknown.action, "KEEP");
  assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", foodKind: "FOOD", foodQuantity: 1, requiredLevel: 15, holderLevel: 12 }).action, "ROUTE");
  assert.match(classifyMailItem({ version: "classic-era", bound: "UNBOUND", foodKind: "BUFF_FOOD", foodQuantity: 3, foodStackSize: 1, requiredLevel: 8, holderLevel: 12 }).reason ?? "", /one stack \(1\)/);
  assert.match(classifyMailItem({ version: "forever", bound: "UNBOUND", foodKind: "UNKNOWN", foodQuantity: 3 }).reason ?? "", /category is UNKNOWN/);
  assert.deepEqual(rankFoodDrinkRows([{ id: "low", tier: 5, sourceOrder: 0 }, { id: "unknown", tier: "UNKNOWN" as const, sourceOrder: 1 }, { id: "high", tier: 10, sourceOrder: 2 }]).map((row) => row.id), ["high", "low", "unknown"]);
  assert.match(buff.reason, /quantity 3/);
});
