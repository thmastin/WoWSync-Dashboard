import assert from "node:assert/strict";
import { test } from "node:test";
import { foreverBuildVerification, foreverProfileOf, isForeverClient, parseForeverProfile } from "../src/foreverProfile.ts";

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
