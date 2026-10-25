import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { classifyMailItem } from "../src/mailItemClassification.ts";
import { classicClassCanEquip } from "../src/classicMailProficiency.ts";

const fixture = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8");
const NOW = 1_792_860_800;

test("Ashtest Classic Era keeps own recipe reagents, usable consumables and conjured healthstone", () => {
  const items = [
    [2672, "Stringy Wolf Meat"], [2886, "Crag Boar Rib"], [2677, "Boar Ribs"], [3173, "Bear Meat"],
    [117, "Tough Jerky"], [4540, "Tough Hunk of Bread"], [159, "Refreshing Spring Water"], [118, "Minor Healing Potion"],
    [2679, "Charred Wolf Meat"], [2681, "Roasted Boar Meat"], [2888, "Beer Basted Boar Ribs"], [17119, "Deeprun Rat Kabob"], [5512, "Minor Healthstone"],
    [2589, "Linen Cloth"], [3174, "Spider Ichor"], [4862, "Broken Boar Tusk"],
    [100001, "Infantry Cloak"],
  ] as const;
  const extra = items.map(([id, name]) => `item:${id}\t${name}\t1\tno\t1`).join("\n");
  const injected = fixture.replace(/Level: 10/, "Level: 11").replace("Herbalism\t1\t75", "Cooking\t8\t75\nHerbalism\t2\t75")
    .replace(/\n\n\[BANK\]/, `\n${extra}\n\n[BANK]`)
    .replace("baseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent", "baseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n100001\t4\t1\t0\t254\tno\n3174\t7\t0\t0\t254\tyes\n4862\t7\t0\t0\t254\tyes");
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(injected.replace(/Generated: \d+/, `Generated: ${NOW}`), { characterState: {
      formatVersion: 1, clientFamily: "Classic",
      professionRecipes: { capture: 1, revision: 1, observedAt: NOW, completeness: "complete", data: { formatVersion: 1, clientFamily: "1.15.9", professions: [{ name: "Cooking", professionName: "Cooking", observedAt: NOW, sessionObservedAt: NOW,
        recipes: [...["Stringy Wolf Meat", "Boar Ribs", "Bear Meat"].map((name) => ({ name: `Cook ${name}`, reagents: [{ name, count: 1 }] })), { name: "Beer Basted Boar Ribs", reagents: [{ name: "Crag Boar Rib", count: 1 }] }] }] } },
    } as any });
    const auctionText = injected.replace(/Name: Ashtest/, "Name: Bankytest").replace("Cooking\t8\t75\nHerbalism\t2\t75", "Herbalism\t1\t75").replace(/Generated: \d+/, `Generated: ${NOW}`);
    store.importSnapshot(auctionText);
    const auction = store.listCharacters("classic-era").find((row) => row.name === "Bankytest")!;
    store.setMailPlanSettings({ accountId: "default", version: "classic-era", realm: "Mankrik", faction: "Alliance", auctionCharacterIdentityKey: auction.identityKey, updatedAt: NOW, provenance: "USER_CONFIGURED" });
    const plan = new DashboardReadModel(store, () => NOW + 1).getClassicEraMailPlan({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(plan.status, "FOUND");
    if (plan.status !== "FOUND") return;
    const rows = (plan as any).value.data.items as Array<{ name?: string; action: string; reason?: string }>;
    for (const name of ["Stringy Wolf Meat", "Boar Ribs", "Bear Meat"]) {
      const row = rows.find((candidate) => candidate.name === name);
      assert.equal(row?.action, "KEEP", row?.reason);
      assert.equal(row?.reason, "possible reagent for recipe; learned state is UNKNOWN");
    }
    for (const name of ["Tough Jerky", "Tough Hunk of Bread", "Refreshing Spring Water", "Minor Healing Potion", "Roasted Boar Meat", "Charred Wolf Meat", "Beer Basted Boar Ribs", "Deeprun Rat Kabob"]) assert.equal(rows.find((row) => row.name === name)?.reason, "consumable");
    assert.deepEqual([rows.find((row) => row.name === "Recipe: Beer Basted Boar Ribs")?.action, rows.find((row) => row.name === "Recipe: Beer Basted Boar Ribs")?.reason], ["KEEP", "learn at Cooking 25 (now 8)"]);
    assert.equal(rows.find((row) => row.name === "Crag Boar Rib")?.reason, "reagent for recipe to learn");
    assert.equal(rows.find((row) => row.name === "Beer Basted Boar Ribs")?.reason, "consumable");
    assert.deepEqual([rows.find((row) => row.name === "Infantry Cloak")?.action, rows.find((row) => row.name === "Infantry Cloak")?.reason], ["KEEP", "possible upgrade, unverified"]);
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
    for (const name of ["Linen Cloth", "Spider Ichor", "Broken Boar Tusk"]) assert.equal(rows.find((row) => row.name === name)?.action, "MAIL_TO_AUCTION_CHARACTER");
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

test("Classic class proficiency is version scoped and rejects observed Warlock shields", () => {
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 4, 6, "INVTYPE_SHIELD"), false);
  assert.equal(classicClassCanEquip("forever", "WARLOCK", 4, 6, "INVTYPE_SHIELD"), false);
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 2, 15, "INVTYPE_WEAPON"), true);
  assert.equal(classicClassCanEquip("classic-era", undefined, 4, 6, "INVTYPE_SHIELD"), undefined);
  assert.equal(classicClassCanEquip("classic-era", "WARLOCK", 4, undefined, "INVTYPE_SHIELD"), undefined);
});
