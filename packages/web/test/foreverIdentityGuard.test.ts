import assert from "node:assert/strict";
import { test } from "node:test";
import { foreverSnapshotIdentityIssue } from "../src/foreverIdentityGuard.ts";

test("Forever detail allows pre-GUID history when all captured GUIDs agree with latest", () => {
  assert.equal(foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A" }, undefined, { sourceCharacterGuid: "Player-1-A" }]), undefined);
});

test("Forever detail blocks when latest snapshot has no GUID", () => {
  const issue = foreverSnapshotIdentityIssue([undefined, { sourceCharacterGuid: "Player-1-A" }]);
  assert.match(issue ?? "", /latest Forever snapshot has no WoWSyncDB character GUID/);
});

test("Forever detail blocks when history contains two different GUIDs", () => {
  const issue = foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A" }, { sourceCharacterGuid: "Player-2-B" }]);
  assert.match(issue ?? "", /differing WoWSyncDB character GUIDs/);
});

test("Forever detail honors duplicate-snapshot source GUID conflict markers", () => {
  const issue = foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A", sourceCharacterGuidConflict: true }]);
  assert.match(issue ?? "", /GUID conflict marker/);
});
