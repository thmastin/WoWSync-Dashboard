// Confirmation behavior for character deletion: what the dialog says it will
// delete, and when the destructive button may enable. (The React modal only
// renders these; the rules live in deleteConfirmation.ts.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDeletion, isDeleteConfirmed, requiredConfirmationText, type DeleteTarget } from "../src/deleteConfirmation.ts";

const hallo: DeleteTarget = {
  identityKey: "forever::classic beta pvp 2::hallo emberstone",
  name: "Hallo Emberstone",
  realm: "Classic Beta PvP 2",
  versionLabel: "Forever",
  snapshotCount: 2,
};

test("the required confirmation is the character's exact name", () => {
  assert.equal(requiredConfirmationText(hallo), "Hallo Emberstone");
});

test("deletion is confirmed only by typing the exact name", () => {
  assert.equal(isDeleteConfirmed("Hallo Emberstone", hallo), true);
  assert.equal(isDeleteConfirmed("  Hallo Emberstone  ", hallo), true, "surrounding whitespace from a paste is ignored");
});

test("nothing short of the exact name confirms: empty, partial, wrong case, different name, identity key, extra text", () => {
  for (const typed of [
    "",
    " ",
    "Hallo",
    "Emberstone",
    "hallo emberstone",
    "HALLO EMBERSTONE",
    "Hallo  Emberstone",
    "Hallo Emberstone!",
    "Hallo Emberstone Jr",
    "delete",
    "yes",
    hallo.identityKey,
  ]) {
    assert.equal(isDeleteConfirmed(typed, hallo), false, JSON.stringify(typed));
  }
});

test("a target with an empty name can never be confirmed (not even by typing nothing)", () => {
  assert.equal(isDeleteConfirmed("", { ...hallo, name: "" }), false);
  assert.equal(isDeleteConfirmed("   ", { ...hallo, name: "" }), false);
});

test("the dialog states clearly what will be deleted: character, realm, version, snapshot count, permanence, and scope", () => {
  const text = describeDeletion(hallo).join("\n");
  assert.match(text, /Character: Hallo Emberstone/);
  assert.match(text, /Realm: Classic Beta PvP 2/);
  assert.match(text, /Version: Forever/);
  assert.match(text, /2 stored snapshots/);
  assert.match(text, /permanently/i);
  assert.match(text, /can't be undone/i);
  assert.match(text, /Other characters, realms, and versions are not affected/);
});

test("the snapshot count is pluralized correctly", () => {
  assert.match(describeDeletion({ ...hallo, snapshotCount: 1 }).join("\n"), /1 stored snapshot\b(?!s)/);
  assert.match(describeDeletion({ ...hallo, snapshotCount: 0 }).join("\n"), /0 stored snapshots/);
});
