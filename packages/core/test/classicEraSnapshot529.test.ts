import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DashboardReadModel } from "../src/readModel.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

const raw = readFileSync(fileURLToPath(new URL("./fixtures/classic-era/snapshot-529-anonymized.wowsync.txt", import.meta.url)), "utf8");
const NOW = 1_792_700_000;

test("anonymized DEV snapshot 529 preserves its real Era observations and explicit empty professions", () => {
  const parsed = parseWowSyncExport(raw);
  assert.equal(parsed.character.clientVersion, "1.15.9");
  assert.equal(parsed.character.clientBuild, "70003");
  assert.equal(parsed.character.faction, "Alliance");
  assert.equal(parsed.character.guid, undefined, "snapshot 529 predates the GUID export line");
  assert.equal(parsed.character.talentStatus, undefined, "snapshot 529 predates the talent export lines");
  assert.equal(parsed.bags.status.state, "OBSERVED");
  assert.deepEqual(parsed.bags.containers.slice(0, 2).map(({ capacity, free }) => [capacity, free]), [[20, 7], [6, 5]]);
  assert.equal(parsed.bags.freeSlots, 12);
  assert.equal(parsed.bags.totalSlots, 26);
  assert.deepEqual(parsed.bags.items.find((item) => item.itemRef?.startsWith("item:5571:")), {
    itemRef: "item:5571::::::::2::::::::::", name: "Small Black Pouch", qty: 1, bound: "no", vendorEachCopper: 250,
  });
  assert.equal(parsed.bags.items.find((item) => item.itemRef?.startsWith("item:2187:"))?.bound, "yes");
  assert.equal(parsed.equipment.status.state, "OBSERVED");
  assert.equal(parsed.equipment.slots.length, 19);
  assert.equal(parsed.professions.status.state, "OBSERVED");
  assert.equal(parsed.professions.entries.length, 0);
  assert.equal(parsed.professions.noneMessage, "None identified in exposed skill lines");
});

test("snapshot 529 remains usable as a value observation but missing GUID prevents mail routing", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(raw);
    const result = new DashboardReadModel(store, () => NOW).getClassicEraMailPlan({
      version: "classic-era", name: "Snapshot529", realm: "AnonymizedEraRealm",
    });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND" || !("data" in result.value) || !result.value.data) throw new Error("Expected Era plan data");
    const plan = result.value.data;
    assert.equal(plan.version, "classic-era");
    assert.equal(plan.buildVerification, "VERIFIED");
    assert.equal(plan.identity.state, "UNKNOWN");
    assert.equal(plan.auctionHouse.state, "UNKNOWN");
    const pouch = plan.items.find((item) => item.name === "Small Black Pouch");
    assert.equal(pouch?.vendorEachCopper, 250);
    assert.equal(pouch?.action, "UNDETERMINED");
    assert.match(pouch?.reason ?? "", /GUID is missing/);
  } finally { store.close(); }
});
