import assert from "node:assert/strict";
import { test } from "node:test";
import { foreverSnapshotIdentityIssue } from "../src/foreverIdentityGuard.ts";

test("Forever detail suppresses inventory when Dashboard history combines source character GUIDs", () => {
  const issue = foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A" }, { sourceCharacterGuid: "Player-2-B" }]);
  assert.match(issue ?? "", /Multiple WoWSyncDB character GUIDs/);
});

test("Forever detail suppresses history when any source character GUID is missing", () => {
  const issue = foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A" }, undefined]);
  assert.match(issue ?? "", /without a WoWSyncDB character GUID/);
});

test("Forever detail allows inventory only when every snapshot shares one source GUID", () => {
  assert.equal(foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A" }, { sourceCharacterGuid: "Player-1-A" }]), undefined);
});

test("Forever detail honors duplicate-snapshot source GUID conflict markers", () => {
  const issue = foreverSnapshotIdentityIssue([{ sourceCharacterGuid: "Player-1-A", sourceCharacterGuidConflict: true }]);
  assert.match(issue ?? "", /Conflicting WoWSyncDB character GUIDs/);
});
