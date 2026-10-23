import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { assertForeverAllocationContract, foreverAllocationContractViolations } from "./foreverAllocationContract.ts";

const HALLO_EXPORT = fileURLToPath(new URL("./fixtures/forever/hallo-1789731867.wowsync.txt", import.meta.url));
const HALLO_70338_IMPORT = fileURLToPath(new URL("./fixtures/forever/copilot-hallo-pvp2.import.json", import.meta.url));
const RORDIN_70338_IMPORT = fileURLToPath(new URL("./fixtures/forever/copilot-rordin.import.json", import.meta.url));
const NOW = 1_789_731_867 + 60;

test("[REAL OBSERVED FIXTURE] a pre-70291 Hallo export is kept outside the 70291 allocation evaluator", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(readFileSync(HALLO_EXPORT, "utf8"));
    const result = new DashboardReadModel(store, () => NOW).getForeverGearAllocation({
      version: "forever", name: "Hallo Emberstone", realm: "Classic Beta PvP 2",
    });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") throw new Error("Expected a version-scoped response for the real Hallo fixture");
    assert.equal(result.value.data, undefined, "the committed real export is build 69913 and must not be treated as the requested 70291 profile");
    assert.equal(result.value.provenance.state, "UNKNOWN", "an older unverified build is never interpreted as a 70291 allocation");
    const mailPlan = new DashboardReadModel(store, () => NOW).getForeverMailPlan({ version: "forever", name: "Hallo Emberstone", realm: "Classic Beta PvP 2" });
    assert.equal(mailPlan.status, "FOUND");
    if (mailPlan.status === "FOUND") assert.equal(mailPlan.value.provenance.state, "UNKNOWN", "an unsupported observed build cannot produce a guessed mail plan");
  } finally {
    store.close();
  }
});

test("[REAL OBSERVED FIXTURE] Forever 70338 Hallo Emberstone receives a current-build mail plan", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const { text, ...sidecars } = JSON.parse(readFileSync(HALLO_70338_IMPORT, "utf8"));
    store.importSnapshot(text, sidecars);
    const { text: rordinText, ...rordinSidecars } = JSON.parse(readFileSync(RORDIN_70338_IMPORT, "utf8"));
    store.importSnapshot(rordinText, rordinSidecars);
    const result = new DashboardReadModel(store, () => 1_791_741_180).getForeverMailPlan({ version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND" || !result.value.data || !("mail" in result.value.data)) throw new Error("Expected the 70338 mail-plan projection");
    assert.equal(result.value.data.ruleset, "forever-min-70291-allocation-screen-v3");
    assert.equal(result.value.data.buildVerification, "VERIFIED");
    assert.equal(result.value.data.build, 70338, "numeric build accompanies verification");
    assert.equal(result.value.data.confidenceQualifier, "STANDARD");
    assert.deepEqual(result.value.data.plannedSpecs, []);
    assert.deepEqual(result.value.data.professionChecks.map((row) => row.character).sort(), ["Hallo", "Rordin"], "the real same-realm Forever roster is consulted");
    assert.ok(Array.isArray(result.value.data.screenedRecipients));
    assert.ok(result.value.data.screenedRecipients.every((row) => "name" in row && "class" in row && "level" in row && "faction" in row && "snapshotId" in row && "freshness" in row && "evaluation" in row));
    assert.equal(result.value.data.scope.accountMembership, "UNKNOWN");
    assert.ok(result.value.data.mail.every((row) => row.buildVerification === "VERIFIED"));
  } finally {
    store.close();
  }
});

test("[SYNTHETIC ADVERSARIAL] the invariant checker identifies an unsupported cross-character transfer conclusion", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-min-70291-allocation-screen-v3",
    scope: { accountMembership: "UNKNOWN" },
    allocationPlan: [{
      disposition: "POSSIBLE_OTHER_CHARACTER",
      item: { itemRef: "item:2901::::::::9:1485::14:::::::" },
      source: { identityKey: "forever::classic-beta-pvp-2::hallo" },
      recipient: { identityKey: "forever::classic-beta-pvp-2::fizzwick" },
      evidence: { transferability: "ALLOWED" },
    }],
  };
  const violations = foreverAllocationContractViolations(invalid);
  assert.deepEqual(violations, ["UNKNOWN_MEMBERSHIP_DOES_NOT_PROVE_TRANSFER: allocationPlan[0] crosses characters while account membership is UNKNOWN"]);
  assert.throws(() => assertForeverAllocationContract(invalid), /UNKNOWN_MEMBERSHIP_DOES_NOT_PROVE_TRANSFER/);
});

test("[SYNTHETIC REGRESSION] source-local recipient screening cannot claim transferability is allowed", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-min-70291-allocation-screen-v3",
    scope: { accountMembership: "UNKNOWN" },
    recipientEvaluations: [{
      itemRef: "item:2901::::::::4:1482::14:::::::",
      source: { identityKey: "forever::classic-beta-pvp-2::fizzwick" },
      recipients: [{ identityKey: "forever::classic-beta-pvp-2::fizzwick", transferability: "ALLOWED" }],
    }],
  };
  assert.deepEqual(foreverAllocationContractViolations(invalid), [
    "SOURCE_LOCAL_SCREEN_DOES_NOT_ESTABLISH_TRANSFER: recipientEvaluations[0].recipients[0] labels a source-local item transfer as ALLOWED",
  ]);
  assert.throws(() => assertForeverAllocationContract(invalid), /SOURCE_LOCAL_SCREEN_DOES_NOT_ESTABLISH_TRANSFER/);
});

test("[SYNTHETIC REGRESSION] source-local assessment cannot claim transferability is allowed", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-min-70291-allocation-screen-v3",
    scope: { accountMembership: "UNKNOWN" },
    assessments: [{
      source: { identityKey: "forever::classic-beta-pvp-2::fizzwick" },
      recipient: { identityKey: "forever::classic-beta-pvp-2::fizzwick" },
      transferability: "ALLOWED",
    }],
  };
  assert.deepEqual(foreverAllocationContractViolations(invalid), [
    "SOURCE_LOCAL_SCREEN_DOES_NOT_ESTABLISH_TRANSFER: assessments[0] labels a source-local item transfer as ALLOWED",
  ]);
  assert.throws(() => assertForeverAllocationContract(invalid), /SOURCE_LOCAL_SCREEN_DOES_NOT_ESTABLISH_TRANSFER/);
});

test("[SYNTHETIC ADVERSARIAL] a same-character equipment candidate still preserves exact item identity", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-min-70291-allocation-screen-v3",
    scope: { accountMembership: "UNKNOWN" },
    allocationPlan: [{ disposition: "EQUIP_CANDIDATE", item: {}, source: { identityKey: "same" }, recipient: { identityKey: "same" } }],
  };
  assert.throws(() => assertForeverAllocationContract(invalid), /EXACT_ITEM_VARIANT_PRESERVED/);
});
