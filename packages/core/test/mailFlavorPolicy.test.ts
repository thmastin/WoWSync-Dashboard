import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { classicEraBuildVerification, classicEraGuidContinuity, classifyMailFreshness, deriveClassicEraSpec, MAIL_FLAVOR_POLICIES, orchestrateFlavorMailPlan } from "../src/mailFlavorPolicy.ts";

test("flavor policies keep build verification and AH sources isolated", () => {
  assert.equal(classicEraBuildVerification({ clientVersion: "1.15.9", clientBuild: "70003" }), "VERIFIED");
  assert.equal(classicEraBuildVerification({ clientVersion: "1.15.10", clientBuild: "70004" }), "UNVERIFIED_BUILD");
  assert.equal(classicEraBuildVerification({ clientVersion: "1.60.1", clientBuild: "70338", clientFamily: "Forever" }), "UNSUPPORTED");
  assert.equal(MAIL_FLAVOR_POLICIES["classic-era"].auctionPriceSource, "UNKNOWN");
  assert.equal(MAIL_FLAVOR_POLICIES.forever.auctionPriceSource, "FOREVER_MARKET");
});

test("Classic Era identity requires a stable observed GUID", () => {
  assert.equal(classicEraGuidContinuity("Player-1-A", ["Player-1-A"]).state, "OBSERVED");
  assert.equal(classicEraGuidContinuity(undefined, []).state, "UNKNOWN");
  assert.equal(classicEraGuidContinuity("Player-1-A", ["Player-1-B"]).state, "UNKNOWN");
});

test("shared flavor orchestrator preserves Forever step order and stamps the selected ruleset", () => {
  const groups = { gear: ["gear"], materials: ["material"], pouches: ["pouch"], sale: ["sale"], keep: ["keep"] };
  const forever = orchestrateFlavorMailPlan(MAIL_FLAVOR_POLICIES.forever, groups);
  assert.equal(forever.version, "forever");
  assert.equal(forever.ruleset, "forever-min-70291-allocation-screen-v3");
  assert.deepEqual(forever.steps.map((step) => step.kind), ["GEAR_MAIL", "MATERIAL_MAIL", "POUCH_MAIL", "SALE", "KEEP"]);
  const era = orchestrateFlavorMailPlan(MAIL_FLAVOR_POLICIES["classic-era"], groups);
  assert.equal(era.version, "classic-era");
  assert.equal(era.ruleset, "classic-era-build-70003-mail-v1");
  assert.deepEqual(era.steps, forever.steps);
});

test("Classic Era freshness is 72 hours and talent spec is DERIVED only from an unambiguous observed tree", () => {
  const policy = MAIL_FLAVOR_POLICIES["classic-era"];
  assert.equal(classifyMailFreshness(policy, 1_000, 1_000 + 72 * 60 * 60), "recent");
  assert.equal(classifyMailFreshness(policy, 1_000, 1_001 + 72 * 60 * 60), "stale");
  assert.deepEqual(deriveClassicEraSpec([{ name: "Arms", pointsSpent: 31 }, { name: "Fury", pointsSpent: 20 }], "OBSERVED"), { state: "DERIVED", name: "Arms", pointsSpent: 31 });
  assert.equal(deriveClassicEraSpec([{ name: "Arms", pointsSpent: 20 }, { name: "Fury", pointsSpent: 20 }], "OBSERVED").state, "UNKNOWN");
  assert.equal(deriveClassicEraSpec([], "UNKNOWN").state, "UNKNOWN");
});

test("Classic Era mail plan reads only Era bags and never falls back to same-name Forever rows", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const now = 1_792_000_000;
    const eraRaw = buildWowSyncExport({ generatedAt: now, character: {
    name: "SameName", realm: "SameRealm", class: "Warrior", faction: "Alliance", level: 60, clientVersion: "1.15.9", clientBuild: "70003",
    }, bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:529", name: "Era item", qty: 1, vendorEachCopper: 47 }] }] }, professions: { entries: [] } })
      .replace("Client: 1.15.9 build 70003\n", "Client: 1.15.9 build 70003\nGUID: Player-529-ANON\nTalentStatus: OBSERVED\ntalentTree\tname\tpointsSpent\ntalentTree\tArms\t31\ntalentTree\tFury\t20\ntalentTree\tProtection\t0\n");
    const foreverRaw = buildWowSyncExport({ generatedAt: now, character: {
      name: "SameName", realm: "SameRealm", class: "Warrior", faction: "Alliance", level: 60, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001",
    }, bags: { containers: [{ id: 0, capacity: 16, free: 14, items: [{ itemRef: "item:529", name: "Forever item", qty: 2, vendorEachCopper: 999 }] }] } });
    store.importSnapshot(eraRaw);
    store.importSnapshot(foreverRaw);
    const plan = new DashboardReadModel(store, () => now).getClassicEraMailPlan({ version: "classic-era", name: "SameName", realm: "SameRealm" });
    assert.equal(plan.status, "FOUND");
    if (plan.status !== "FOUND" || !("data" in plan.value) || !plan.value.data) throw new Error("Expected Era plan data");
    assert.equal(plan.value.data.items[0]?.name, "Era item");
    assert.equal(plan.value.data.items[0]?.vendorEachCopper, 47);
    assert.equal(plan.value.data.items[0]?.auctionHouseValue, "UNKNOWN");
    assert.equal(plan.value.data.talentSpec.state, "DERIVED");
    assert.equal(plan.value.data.talentSpec.name, "Arms");
    assert.equal(plan.value.data.buildVerification, "VERIFIED");
  } finally { store.close(); }
});
