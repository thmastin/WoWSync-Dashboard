import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { eligibleMailRecipients, orderMailPlanSteps, routeMaterial, routePouch, type MailRoutingRecipient } from "../src/foreverMailRouting.ts";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/forever/mail-routing-dev-anonymized.json", import.meta.url)), "utf8"));
const rows = fixture.scenarioRows as Array<MailRoutingRecipient & { bagSlots?: number }>;
const source = { identityKey: "fixture::source", realm: "Classic Beta PvE", faction: "Alliance" };
const eligible = eligibleMailRecipients(source, rows);
const material = { itemId: fixture.observedForeverItemIds.craftingMaterial as number, name: "Material", quantity: 2 };

test("recent anonymized DEV fixture routes a captured material to its OBSERVED crafter", () => {
  const result = routeMaterial(material, eligible);
  assert.deepEqual(result.map((row) => row.disposition), ["MAIL_TO_CRAFTER"]);
  if (result[0]?.disposition === "MAIL_TO_CRAFTER") assert.equal(result[0].recipient.name, "Alt A");
});

test("no captured recipe user with complete recipe coverage selects AH when AH net exceeds vendor", () => {
  const result = routeMaterial(material, [{ ...rows[1]!, recipeKnowledgeComplete: true }], { ahMedianUnitCopper: 100, vendorUnitCopper: 40 });
  assert.equal(result[0]?.disposition, "SELL_AH");
  assert.match(result[0]?.reason ?? "", /AH net 182 copper.*vendor 80 copper/);
});

test("no captured recipe user with complete recipe coverage selects vendor when vendor exceeds AH net", () => {
  const result = routeMaterial(material, [{ ...rows[1]!, recipeKnowledgeComplete: true }], { ahMedianUnitCopper: 20, vendorUnitCopper: 40 });
  assert.equal(result[0]?.disposition, "VENDOR");
  assert.match(result[0]?.reason ?? "", /AH net 30 copper.*vendor 80 copper/);
});

test("missing either sale price is UNKNOWN and both missing say sell: price UNKNOWN", () => {
  for (const options of [{ vendorUnitCopper: 10 }, { ahMedianUnitCopper: 20 }, {}]) {
    const result = routeMaterial(material, [rows[1]!], options);
    assert.equal(result[0]?.disposition, "KEEP");
    assert.match(result[0]?.reason ?? "", /sell: price UNKNOWN/);
  }
});

test("an UNKNOWN recipient profession blocks sale", () => {
  const result = routeMaterial(material, [{ ...rows[1]!, professionsState: "UNKNOWN" }], { ahMedianUnitCopper: 100, vendorUnitCopper: 2 });
  assert.equal(result[0]?.disposition, "KEEP");
  assert.match(result[0]?.reason ?? "", /profession is UNKNOWN/);
});

test("LAST_SEEN professions remain distinct and also block sale", () => {
  const result = routeMaterial(material, [{ ...rows[1]!, professionsState: "LAST_SEEN" }], { ahMedianUnitCopper: 100, vendorUnitCopper: 2 });
  assert.equal(result[0]?.disposition, "KEEP");
  assert.match(result[0]?.reason ?? "", /LAST_SEEN/);
  assert.doesNotMatch(result[0]?.reason ?? "", /profession is UNKNOWN/);
});

test("held material stays KEEP with the exact configured reason", () => {
  const result = routeMaterial(material, eligible, { heldItemIds: new Set([material.itemId]) });
  assert.deepEqual(result.map((row) => [row.disposition, row.reason]), [["KEEP", "on hold list"]]);
});

test("anonymized snapshot-541 holder professions keep own known reagents and incomplete recipe coverage blocks sale", () => {
  const scenario = fixture.snapshot541Scenario as { snapshotId: number; materials: Array<{ itemId: number; usedBy: string; recipeEvidence: "OBSERVED" | "LAST_SEEN" }> };
  assert.equal(scenario.snapshotId, 541);
  const holder: MailRoutingRecipient = {
    identityKey: "fixture::holder", name: "Holder", realm: "Classic Beta PvE", faction: "Alliance",
    professionsState: "OBSERVED", observedReagentIds: [], recipeKnowledgeComplete: false,
    reagentProfessions: scenario.materials.map(({ itemId, usedBy, recipeEvidence }) => ({ itemId, profession: usedBy, evidence: recipeEvidence })),
  };
  for (const { itemId, usedBy } of scenario.materials) {
    const result = routeMaterial({ itemId, quantity: 1 }, [holder, ...eligible], { holderIdentityKey: holder.identityKey, ahMedianUnitCopper: 200, vendorUnitCopper: 1 });
    assert.equal(result[0]?.disposition, "KEEP");
    assert.match(result[0]?.reason ?? "", new RegExp(`used by your own ${usedBy}`));
  }
  const possibleUse = routeMaterial({ itemId: 900001, quantity: 1 }, [holder, ...eligible], { holderIdentityKey: holder.identityKey, ahMedianUnitCopper: 200, vendorUnitCopper: 1 });
  assert.equal(possibleUse[0]?.disposition, "KEEP");
  assert.match(possibleUse[0]?.reason ?? "", /recipe data is incomplete/);
  assert.doesNotMatch(possibleUse[0]?.reason ?? "", /SELL_AH|VENDOR/);
});

test("pouch goes to the eligible alt with fewest OBSERVED bag slots; UNKNOWN and cross-faction are skipped", () => {
  const result = routePouch({ itemId: fixture.observedForeverItemIds.containerItem }, [
    ...eligible.map((row) => ({ ...row, observedBagSlots: row.bagSlots })),
    { ...rows[1]!, identityKey: "fixture::unknown-slots", observedBagSlots: undefined },
  ]);
  assert.equal(result.disposition, "POUCH_TO_ALT");
  if (result.disposition === "POUCH_TO_ALT") assert.equal(result.recipient.name, "Alt A");
});

test("same-realm cross-faction recipients are excluded", () => {
  assert.deepEqual(eligible.map((row) => row.name), ["Alt A", "Alt B"]);
});

test("mail-plan steps order gear, materials, sale, then keep and each entry remains one action", () => {
  const steps = orderMailPlanSteps({ gear: ["gear"], materials: ["mat"], pouches: ["pouch"], sale: ["sale"], keep: ["keep"] });
  assert.deepEqual(steps.map((step) => step.kind), ["GEAR_MAIL", "MATERIAL_MAIL", "POUCH_MAIL", "SALE", "KEEP"]);
  assert.deepEqual(steps.map((step) => step.action), ["gear", "mat", "pouch", "sale", "keep"]);
});
