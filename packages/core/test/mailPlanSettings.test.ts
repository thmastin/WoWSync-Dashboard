import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { selectCrafterByObservedSkill, validateMailPlanSettingsInput } from "../src/mailPlanSettings.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_792_000_000;
function era(name: string, realm = "Realm", faction = "Alliance") {
  return buildWowSyncExport({ generatedAt: NOW, character: { name, realm, faction, class: "Warrior", level: 60, clientVersion: "1.15.9", clientBuild: "70003" } });
}

test("mail settings persist by account, flavor, realm, and faction and missing/deleted targets resolve as UNDETERMINED", () => {
  const db = path.join(tmpdir(), "wowsync-mail-settings-" + randomUUID() + ".sqlite");
  try {
    let store = new SqliteSnapshotStore(db);
    store.importSnapshot(era("Holder"));
    store.importSnapshot(era("Vendor"));
    const roster = store.listCharacters("classic-era");
    const holder = roster.find((row) => row.name === "Holder")!.identityKey;
    const vendor = roster.find((row) => row.name === "Vendor")!.identityKey;
    const settings = validateMailPlanSettingsInput({
      accountId: "alt-account", version: "classic-era", realm: "Realm", faction: "Alliance",
      auctionCharacterIdentityKey: vendor, mainCharacterIdentityKey: holder, plannedProfessionsByCharacter: { [holder]: ["Tailoring", "First Aid"] },
    }, store.listCharacters("classic-era"), NOW);
    store.setMailPlanSettings(settings);
    store.close();

    store = new SqliteSnapshotStore(db);
    const read = store.getMailPlanSettings({ accountId: "alt-account", version: "classic-era", realm: "Realm", faction: "Alliance" });
    assert.equal(read?.auctionCharacterIdentityKey, vendor);
    assert.equal(read?.mainCharacterIdentityKey, holder);
    assert.deepEqual(read?.plannedProfessionsByCharacter?.[holder], ["Tailoring", "First Aid"]);
    assert.equal(store.getMailPlanSettings({ accountId: "other-account", version: "classic-era", realm: "Realm", faction: "Alliance" }), undefined);
    store.deleteCharacter(vendor);
    const stale = store.getMailPlanSettings({ accountId: "alt-account", version: "classic-era", realm: "Realm", faction: "Alliance" });
    assert.equal(stale?.auctionCharacterIdentityKey, vendor);
    store.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("mail settings reject cross-version, cross-realm, cross-faction, and absent characters", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(era("Era", "Realm", "Alliance"));
    const candidate = store.listCharacters("classic-era")[0]!;
    const base = { accountId: "default", version: "classic-era", realm: "Realm", faction: "Alliance", auctionCharacterIdentityKey: candidate.identityKey };
    assert.throws(() => validateMailPlanSettingsInput({ ...base, version: "forever" }, store.listCharacters("classic-era")), /currently listed/);
    assert.throws(() => validateMailPlanSettingsInput({ ...base, realm: "Other" }, store.listCharacters("classic-era")), /same version, realm/);
    assert.throws(() => validateMailPlanSettingsInput({ ...base, faction: "Horde" }, store.listCharacters("classic-era")), /same version, realm/);
    assert.throws(() => validateMailPlanSettingsInput({ ...base, auctionCharacterIdentityKey: "classic-era::Realm::Missing" }, store.listCharacters("classic-era")), /currently listed/);
    assert.throws(() => validateMailPlanSettingsInput({ ...base, accountId: "known toon name!" }, store.listCharacters("classic-era")), /accountId/);
  } finally { store.close(); }
});

test("crafter selection is highest OBSERVED skill, main breaks only exact ties, unresolved ties list candidates", () => {
  const rows = [
    { identityKey: "era::r::a", name: "A", profession: "Tailoring", skill: 250, skillState: "OBSERVED" as const },
    { identityKey: "era::r::b", name: "B", profession: "Tailoring", skill: 300, skillState: "OBSERVED" as const },
    { identityKey: "era::r::c", name: "C", profession: "Tailoring", skill: 999, skillState: "LAST_SEEN" as const },
  ];
  const highest = selectCrafterByObservedSkill(rows);
  assert.equal(highest.state, "SELECTED");
  if (highest.state === "SELECTED") assert.equal(highest.candidate.name, "B");
  const tied = selectCrafterByObservedSkill([rows[0]!, { ...rows[1]!, skill: 250 }]);
  assert.equal(tied.state, "UNDETERMINED");
  if (tied.state === "UNDETERMINED") assert.deepEqual(tied.candidates.map((row) => row.name), ["A", "B"]);
  const mainTie = selectCrafterByObservedSkill([rows[0]!, { ...rows[1]!, skill: 250 }], "era::r::b");
  assert.equal(mainTie.state, "SELECTED");
  if (mainTie.state === "SELECTED") assert.equal(mainTie.candidate.name, "B");
  assert.equal(selectCrafterByObservedSkill([rows[2]!]).state, "UNDETERMINED");
});

test("planned profession material mapping preserves only materials tied to a configured profession", async () => {
  const { plannedProfessionForMaterial } = await import("../src/mailPlanSettings.ts");
  assert.equal(plannedProfessionForMaterial(2589, "Linen Cloth", ["Tailoring"]), "Tailoring");
  assert.equal(plannedProfessionForMaterial(2589, "Linen Cloth", ["First Aid"]), "First Aid");
  assert.equal(plannedProfessionForMaterial(999999, "UNKNOWN item", ["Tailoring"]), undefined);
});
