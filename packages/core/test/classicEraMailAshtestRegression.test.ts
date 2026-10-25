import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

const fixture = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8");
const NOW = 1_792_860_800;

test("Ashtest Classic Era keeps own recipe reagents, usable consumables and conjured healthstone", () => {
  const items = [
    [2672, "Stringy Wolf Meat"], [2886, "Crag Boar Rib"], [2677, "Boar Ribs"], [3173, "Bear Meat"],
    [117, "Tough Jerky"], [4540, "Tough Hunk of Bread"], [159, "Refreshing Spring Water"], [118, "Minor Healing Potion"],
    [2679, "Charred Wolf Meat"], [2681, "Roasted Boar Meat"], [2888, "Beer Basted Boar Ribs"], [17119, "Deeprun Rat Kabob"], [5512, "Minor Healthstone"],
    [2589, "Linen Cloth"], [3174, "Spider Ichor"], [4862, "Broken Boar Tusk"],
  ] as const;
  const extra = items.map(([id, name]) => `item:${id}\t${name}\t1\tno\t1`).join("\n");
  const injected = fixture.replace(/Level: 10/, "Level: 11").replace("Herbalism\t1\t75", "Cooking\t8\t75\nHerbalism\t2\t75")
    .replace(/\n\n\[BANK\]/, `\n${extra}\n\n[BANK]`);
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(injected.replace(/Generated: \d+/, `Generated: ${NOW}`), { characterState: { formatVersion: 1, clientFamily: "Classic", professionRecipes: {
      capture: 1, revision: 1, observedAt: NOW, completeness: "complete", data: { formatVersion: 1, clientFamily: "1.15.9", professions: [{ name: "Cooking", professionName: "Cooking", observedAt: NOW, sessionObservedAt: NOW,
        recipes: ["Crag Boar Rib", "Stringy Wolf Meat", "Boar Ribs", "Bear Meat"].map((name) => ({ name: `Cook ${name}`, reagents: [{ name, count: 1 }] })) }] },
    } } } as any);
    const auctionText = injected.replace(/Name: Ashtest/, "Name: Bankytest").replace("Cooking\t8\t75\nHerbalism\t2\t75", "Herbalism\t1\t75").replace(/Generated: \d+/, `Generated: ${NOW}`);
    store.importSnapshot(auctionText);
    const auction = store.listCharacters("classic-era").find((row) => row.name === "Bankytest")!;
    store.setMailPlanSettings({ accountId: "default", version: "classic-era", realm: "Mankrik", faction: "Alliance", auctionCharacterIdentityKey: auction.identityKey, updatedAt: NOW, provenance: "USER_CONFIGURED" });
    const plan = new DashboardReadModel(store, () => NOW + 1).getClassicEraMailPlan({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(plan.status, "FOUND");
    if (plan.status !== "FOUND") return;
    const rows = (plan as any).value.data.items as Array<{ name?: string; action: string; reason?: string }>;
    for (const name of ["Crag Boar Rib", "Stringy Wolf Meat", "Boar Ribs", "Bear Meat"]) {
      const row = rows.find((candidate) => candidate.name === name);
      assert.equal(row?.action, "KEEP", row?.reason);
      assert.match(row?.reason ?? "", /known recipe Cook /);
    }
    for (const name of ["Tough Jerky", "Tough Hunk of Bread", "Refreshing Spring Water", "Minor Healing Potion", "Roasted Boar Meat", "Charred Wolf Meat", "Beer Basted Boar Ribs", "Deeprun Rat Kabob"]) assert.equal(rows.find((row) => row.name === name)?.reason, "consumable usable by Ashtest");
    assert.equal(rows.find((row) => row.name === "Minor Healthstone")?.reason, "conjured, can't be mailed");
    for (const name of ["Linen Cloth", "Spider Ichor", "Broken Boar Tusk"]) assert.equal(rows.find((row) => row.name === name)?.action, "MAIL_TO_AUCTION_CHARACTER");
  } finally { store.close(); }
});
