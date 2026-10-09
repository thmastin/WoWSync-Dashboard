import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { assertForeverAllocationContract, foreverAllocationContractViolations } from "./foreverAllocationContract.ts";

const HALLO_EXPORT = fileURLToPath(new URL("./fixtures/forever/hallo-1789731867.wowsync.txt", import.meta.url));
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
    assert.match(result.value.provenance.reason ?? "", /build 70291/);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC ADVERSARIAL] the invariant checker identifies an unsupported cross-character transfer conclusion", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-70291-allocation-screen-v2",
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

test("[SYNTHETIC ADVERSARIAL] a same-character equipment candidate still preserves exact item identity", () => {
  const invalid = {
    version: "forever",
    ruleset: "forever-70291-allocation-screen-v2",
    scope: { accountMembership: "UNKNOWN" },
    allocationPlan: [{ disposition: "EQUIP_CANDIDATE", item: {}, source: { identityKey: "same" }, recipient: { identityKey: "same" } }],
  };
  assert.throws(() => assertForeverAllocationContract(invalid), /EXACT_ITEM_VARIANT_PRESERVED/);
});
