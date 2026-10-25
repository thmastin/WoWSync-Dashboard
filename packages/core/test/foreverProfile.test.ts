import assert from "node:assert/strict";
import { test } from "node:test";
import { foreverBuildVerification, foreverProfileOf, isForeverClient, parseForeverProfile } from "../src/foreverProfile.ts";
import { normalizeForeverStructuredObservation } from "../src/foreverGearObservation.ts";

test("Forever client identity accepts any well-formed build and labels verification separately", () => {
  const launch = { clientFamily: "Forever", clientVersion: "1.61.0", clientBuild: "71234", interface: "16100" };
  assert.equal(isForeverClient(launch), true, "a launch-day build is accepted for storage");
  assert.equal(foreverProfileOf(launch), "Forever:1.61.0:71234:16100");
  assert.equal(foreverBuildVerification("71234"), "UNVERIFIED_BUILD");
  assert.equal(foreverBuildVerification("70338"), "VERIFIED");
  assert.equal(foreverBuildVerification(undefined), "UNVERIFIED_BUILD");
  assert.deepEqual(parseForeverProfile("Forever:1.60.1:70291:16001"), { clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" });
  for (const bad of [{ ...launch, clientFamily: "Retail" }, { ...launch, clientBuild: "beta" }, { ...launch, interface: undefined }, { ...launch, clientVersion: "1.61" }]) assert.equal(isForeverClient(bad), false);
  assert.equal(parseForeverProfile("Forever:1.60.1:70291"), undefined);
});

test("Forever accepts the current complete professionRecipes envelope and keeps learned state UNKNOWN", () => {
  const profile = "Forever:1.60.1:70338:16001";
  const observedAt = 1_792_932_645;
  const normalized = normalizeForeverStructuredObservation({
    clientProfile: profile, name: "Ashtest", realm: "Mankrik", generatedAt: observedAt - 20,
    professionRecipes: { capture: 119, revision: 4, observedAt, completeness: "complete", data: {
      formatVersion: 1, clientFamily: "1.60.1", professions: [{ name: "Cooking", professionName: "Cooking", observedAt, sessionObservedAt: observedAt - 2,
        recipes: [{ name: "Egg", itemID: 6888, reagents: [{ name: "Small Egg", count: 1 }] }, { name: "Mystery", reagents: [{ name: "Cloth", count: 1 }] }] }] } },
  }, "forever", "Ashtest", "Mankrik", observedAt - 20);
  assert.equal(normalized?.professionRecipes?.completeness, "complete");
  const rows = normalized?.professionRecipes?.data.professions as Array<{ recipes: Array<{ outputItemID?: number; learnedState: string }> }>;
  assert.equal(rows[0]?.recipes[1]?.outputItemID, undefined);
  assert.equal(rows[0]?.recipes[1]?.learnedState, "UNKNOWN");
});
