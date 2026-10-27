import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { classifyMailItem } from "../src/mailItemClassification.ts";
import { classicClassCanEquip } from "../src/classicMailProficiency.ts";

const fixture = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8");
const NOW = 1_792_860_800;
const ashtestBagspaceRows = [
  [100101, "Gypsy Buckler of Blocking", 4, 6, "INVTYPE_SHIELD", 20, true, 25],
  [100102, "Infantry Belt", 4, 4, "INVTYPE_WAIST", 20, false, 8],
  [100103, "Cadet Bracers", 4, 4, "INVTYPE_WRIST", 20, true, 10],
  [100104, "Rodentia Flint Axe", 2, 0, "INVTYPE_WEAPON", 20, false, 9, 3],
  [2589, "Linen Cloth", 7, 0, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 2, 53],
  [1081, "Crisp Spider Meat", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 1, 3],
  [5465, "Small Spider Leg", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 1],
  [2677, "Boar Ribs", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 1],
] as const;
const fullBagFillerRows = [
  [10200, "Tier 5 Food fixture", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 5, false, 1, 2],
  [10201, "Tier 10 Food fixture", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 10, false, 1, 2],
  [10202, "Buff Food fixture", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 8, false, 1, 3],
  ...Array.from({ length: 5 }, (_, index) => [10203 + index, `Full bag filler ${index + 1}`, 7, 0, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 1, 1] as const),
] as const;

test("Ashtest Classic Era keeps own recipe reagents, usable consumables and conjured healthstone", () => {
  const items = [
    [2672, "Stringy Wolf Meat"], [2886, "Crag Boar Rib"], [2677, "Boar Ribs"], [3173, "Bear Meat"], [1081, "Crisp Spider Meat"], [5465, "Small Spider Leg"],
    [117, "Tough Jerky"], [4540, "Tough Hunk of Bread"], [159, "Refreshing Spring Water"], [118, "Minor Healing Potion"],
    [2679, "Charred Wolf Meat"], [2681, "Roasted Boar Meat"], [2888, "Beer Basted Boar Ribs"], [17119, "Deeprun Rat Kabob"], [5512, "Minor Healthstone"],
    [2589, "Linen Cloth"], [3174, "Spider Ichor"], [4862, "Broken Boar Tusk"],
    [100001, "Infantry Cloak"],
  ] as const;
  const extra = items.map(([id, name]) => `item:${id}\t${name}\t1\tno\t1`).join("\n");
  const injected = fixture.replace(/Level: 10/, "Level: 11").replace("Herbalism\t1\t75", "Cooking\t19\t75\nHerbalism\t2\t75")
    .replace(/\n\n\[BANK\]/, `\n${extra}\n\n[BANK]`)
    .replace("baseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent", "baseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n100001\t4\t1\t0\t254\tno\n3174\t7\t0\t0\t254\tyes\n4862\t7\t0\t0\t254\tyes");
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const fullBagFixtureRows = [...ashtestBagspaceRows, ...fullBagFillerRows.slice(0, -1), [1081, "Crisp Spider Meat", 0, 5, "INVTYPE_NON_EQUIP_IGNORE", 1, false, 1, 2] as const];
    const classicBagSidecar = { observedAt: NOW, completeness: "complete", data: { formatVersion: 1, containers: [{ id: 0, capacity: 16, slots: Object.fromEntries(fullBagFixtureRows.map(([itemID, name, classID, subClassID, equipLoc, requiredLevel, bound, vendorCopper, count = 1], index) => [String(index + 1), { itemID, itemString: `item:${itemID}`, name, count, bound, itemMetadataState: "OBSERVED", classID, subClassID, equipLoc, requiredLevel, quality: 1, vendorCopper,
      ...(itemID === 10200 ? { foodKind: "FOOD" } : itemID === 10201 ? { foodKind: "FOOD" } : itemID === 10202 ? { foodKind: "BUFF_FOOD", foodStackSize: 1, spellText: "Well Fed" } : {}) }])) }] } };
    store.importSnapshot(injected.replace("Slots: 20 free / 38", "Slots: 0 free / 38").replace(/Generated: \d+/, `Generated: ${NOW}`).replace(/\n\n\[BANK\]/, "\n?\tUNKNOWN item\t1\tno\t?\n\n[BANK]"), { characterState: {
      formatVersion: 1, clientFamily: "Classic",
      bags: classicBagSidecar,
      professionRecipes: { capture: 1, revision: 1, observedAt: NOW, completeness: "complete", data: { formatVersion: 1, clientFamily: "1.15.9", professions: [{ name: "Cooking", professionName: "Cooking", observedAt: NOW, sessionObservedAt: NOW,
        recipes: [...["Stringy Wolf Meat", "Boar Ribs", "Bear Meat"].map((name) => ({ name: `Cook ${name}`, reagents: [{ name, count: 1 }] })), { name: "Beer Basted Boar Ribs", reagents: [{ name: "Crag Boar Rib", count: 1 }] }] }] } },
    } as any });
    const auctionText = injected.replace(/Name: Ashtest/, "Name: Bankytest").replace("Cooking\t19\t75\nHerbalism\t2\t75", "Herbalism\t1\t75").replace(/Generated: \d+/, `Generated: ${NOW}`);
    store.importSnapshot(auctionText);
    const auction = store.listCharacters("classic-era").find((row) => row.name === "Bankytest")!;
    const ashtest = store.listCharacters("classic-era").find((row) => row.name === "Ashtest")!;
    store.setMailPlanSettings({ accountId: "default", version: "classic-era", realm: "Mankrik", faction: "Alliance", auctionCharacterIdentityKey: auction.identityKey, plannedProfessionsByCharacter: { [ashtest.identityKey]: ["Tailoring"] }, updatedAt: NOW, provenance: "USER_CONFIGURED" });
    const plan = new DashboardReadModel(store, () => NOW + 1).getClassicEraMailPlan({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(plan.status, "FOUND");
    if (plan.status !== "FOUND") return;
    const rows = (plan as any).value.data.items as Array<{ name?: string; action: string; reason?: string }>;
    const bagRead = new DashboardReadModel(store, () => NOW + 1).getCharacterBags({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(bagRead.status, "FOUND");
    if (bagRead.status === "FOUND") assert.equal(rows.length + 1, bagRead.value.data?.items?.length, "the identity-less bag row is excluded from plan actions");
    assert.equal(((plan as any).value.data as any).coverageWarnings?.length, 1);
    assert.match(((plan as any).value.data as any).coverageWarnings[0], /no item identity/);
    assert.ok(!rows.some((row) => row.name === "UNKNOWN item"));
    assert.equal(fullBagFixtureRows.length, 16, "the full-bags fixture fills all 16 slots");
    const actionKeys = rows.map((row) => `${row.itemRef ?? row.name}:${row.action}`);
    assert.equal(new Set(actionKeys).size, actionKeys.length, "each item is represented once per action after location aggregation");
    for (const [name, quantity] of [["Crisp Spider Meat", 5], ["Small Spider Leg", 1], ["Boar Ribs", 1]] as const) {
      const matches = rows.filter((row) => row.name === name);
      assert.equal(matches.length, 1, `${name} appears once in the plan`);
      assert.deepEqual([matches[0]?.action, matches[0]?.reason, (matches[0] as any)?.quantity], ["KEEP", "Cooking 19: skill-up mat", quantity]);
    }
    const foodRows = rows.filter((row) => ["Tier 5 Food fixture", "Tier 10 Food fixture", "Buff Food fixture"].includes(row.name ?? ""));
    assert.deepEqual(foodRows.map((row) => row.name), ["Tier 10 Food fixture", "Tier 5 Food fixture", "Buff Food fixture"], JSON.stringify(foodRows));
    assert.equal(foodRows.find((row) => row.name === "Tier 10 Food fixture")?.action, "KEEP");
    assert.equal(foodRows.find((row) => row.name === "Tier 5 Food fixture")?.action, "VENDOR");
    assert.match(rows.find((row) => row.name === "Buff Food fixture")?.reason ?? "", /at most one stack/);
    assert.equal((rows.find((row) => row.name === "Buff Food fixture") as any)?.keepQuantity, 1);
    for (const [, name] of ashtestBagspaceRows) assert.ok(rows.some((row) => row.name === name), `${name} is represented in the mail plan`);
    assert.deepEqual([rows.find((row) => row.name === "Gypsy Buckler of Blocking")?.action, rows.find((row) => row.name === "Gypsy Buckler of Blocking")?.reason], ["VENDOR", "OBSERVED bound item is unusable; vendor value 25 copper each"]);
    assert.equal(rows.find((row) => row.name === "Rodentia Flint Axe")?.action, "MAIL_TO_AUCTION_CHARACTER");
    for (const name of ["Stringy Wolf Meat", "Boar Ribs", "Bear Meat"]) {
      const row = rows.find((candidate) => candidate.name === name);
      assert.equal(row?.action, "KEEP", row?.reason);
      assert.equal(row?.reason, name === "Boar Ribs" ? "Cooking 19: skill-up mat" : "possible reagent for recipe; learned state is UNKNOWN");
    }
    for (const name of ["Tough Jerky", "Tough Hunk of Bread", "Refreshing Spring Water", "Minor Healing Potion", "Roasted Boar Meat", "Charred Wolf Meat", "Beer Basted Boar Ribs", "Deeprun Rat Kabob"]) assert.equal(rows.find((row) => row.name === name)?.reason, "consumable");
    assert.deepEqual([rows.find((row) => row.name === "Recipe: Beer Basted Boar Ribs")?.action, rows.find((row) => row.name === "Recipe: Beer Basted Boar Ribs")?.reason], ["KEEP", "learn at Cooking 25 (now 19)"]);
    assert.equal(rows.find((row) => row.name === "Crag Boar Rib")?.reason, "reagent for recipe to learn");
    assert.equal(rows.find((row) => row.name === "Beer Basted Boar Ribs")?.reason, "consumable");
    assert.deepEqual([rows.find((row) => row.name === "Infantry Cloak")?.action, rows.find((row) => row.name === "Infantry Cloak")?.reason], ["KEEP", "Observed equipment item; upgrade suitability is UNKNOWN."]);
    assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", recipeItem: { professionState: "KNOWN", hasProfession: true, requiredSkill: 8, holderSkill: 8, learnedState: "NOT_LEARNED" } }).action, "LEARN_RECIPE");
    assert.equal(classifyMailItem({ version: "classic-era", itemId: 2886, bound: "UNBOUND", reagentForRecipeToLearn: true }).reason, "reagent for recipe to learn");
    assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", objectiveQuest: "Test active quest" }).reason, "needed for active quest Test active quest");
    assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", quality: 0, vendorEachCopper: 5 }).action, "VENDOR");
    assert.equal(rows.find((row) => row.name === "Minor Healthstone")?.reason, "conjured, can't be mailed");
    const bagRows = new DashboardReadModel(store, () => NOW + 1).getCharacterBags({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(bagRows.status, "FOUND");
    if (bagRows.status === "FOUND") {
      const recipeRow = (bagRows.value.data?.items as any[] | undefined)?.find((item) => item.itemID === 2889);
      assert.deepEqual([recipeRow?.name, recipeRow?.quantity, recipeRow?.quality.state, recipeRow?.recipeLearning?.requiredSkill?.state, recipeRow?.recipeLearning?.requiredSkill?.value], ["Recipe: Beer Basted Boar Ribs", 1, "UNKNOWN", "KNOWN", 25]);
    }
    assert.deepEqual([rows.find((row) => row.name === "Linen Cloth")?.action, rows.find((row) => row.name === "Linen Cloth")?.reason], ["KEEP", "Planned Tailoring"]);
    assert.deepEqual(store.getMailPlanSettings({ accountId: "default", version: "classic-era", realm: "Mankrik", faction: "Alliance" })?.plannedProfessionsByCharacter?.[ashtest.identityKey], ["Tailoring"], "mail planning leaves the player's planned profession list unchanged");
    for (const name of ["Spider Ichor", "Broken Boar Tusk"]) assert.equal(rows.find((row) => row.name === name)?.action, "MAIL_TO_AUCTION_CHARACTER");
  } finally { store.close(); }
});

test("v2 item metadata takes precedence and keeps UNKNOWN fields unresolved", () => {
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", quality: 0, vendorEachCopper: 60, itemMetadataState: "OBSERVED" }).action, "VENDOR");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", itemMetadataState: "OBSERVED", itemClass: 0, requiredLevel: 0, holderLevel: 12 }).reason, "consumable");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", itemMetadataState: "OBSERVED", itemClass: 0, requiredLevel: 25, holderLevel: 12 }).action, "ROUTE");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", itemMetadataState: "OBSERVED", requiredProfession: "Cooking", requiredSkill: 25, recipeAlreadyKnown: false }).action, "LEARN_RECIPE");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", itemMetadataState: "OBSERVED", itemClass: 9, requiredProfession: "Cooking", requiredSkill: 25, recipeAlreadyKnown: true }).action, "ROUTE");
  assert.equal(classifyMailItem({ version: "classic-era", itemId: 118, bound: "UNBOUND", itemMetadataState: "UNKNOWN" }).reason, "consumable");
  assert.equal(classifyMailItem({ version: "forever", bound: "UNBOUND", itemMetadataState: "OBSERVED", itemClass: 9, equipLoc: "INVTYPE_NON_EQUIP_IGNORE" }).action, "ROUTE");
});

test("shared mail classifier uses observed binding, quality, and usability metadata", () => {
  assert.equal(classifyMailItem({ version: "classic-era", bound: "BOUND", classCanEquip: false, vendorEachCopper: 12 }).action, "VENDOR");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", classCanEquip: false }).action, "ROUTE");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "BOUND", quality: 0, vendorEachCopper: 5 }).action, "VENDOR");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", quality: 0 }).action, "VENDOR");
  assert.equal(classifyMailItem({ version: "classic-era", bound: "UNBOUND", equippable: true }).reason, "Observed equipment item; upgrade suitability is UNKNOWN.");
});

test("shared mail classifier keeps profession skill-up materials for OBSERVED learned professions in Era and Forever", () => {
  for (const version of ["classic-era", "forever"] as const) {
    assert.deepEqual(classifyMailItem({ version, bound: "UNBOUND", professionSkillUpMaterial: { profession: "Cooking", skill: 19 } }), { action: "KEEP", reason: "Cooking 19: skill-up mat" });
    assert.deepEqual(classifyMailItem({ version, bound: "UNBOUND", cookingMaterialPlan: { state: "UNKNOWN", keepQuantity: "UNKNOWN", excessQuantity: "UNKNOWN", reason: "Other cooking-plan note" }, professionSkillUpMaterial: { profession: "Cooking", skill: 19 } }), { action: "KEEP", reason: "Cooking 19: skill-up mat" });
  }
});

test("Classic class proficiency is version scoped and rejects observed Warlock shields", () => {
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 4, 6, "INVTYPE_SHIELD"), false);
  assert.equal(classicClassCanEquip("forever", "WARLOCK", 4, 6, "INVTYPE_SHIELD"), false);
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 2, 15, "INVTYPE_WEAPON"), true);
  assert.equal(classicClassCanEquip("classic-era", undefined, 4, 6, "INVTYPE_SHIELD"), undefined);
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 4, undefined, "INVTYPE_SHIELD"), undefined);
});
