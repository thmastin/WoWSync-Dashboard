// Azeroth ERP Vertical Slice 3 — pure item-string normalization, identity classification, and binding
// mapping (heldItemIdentity.ts). No store, no fixtures: the end-to-end scenarios live in
// readModelAllocation.test.ts and readModelAllocationReview.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingState, classifyItemStringIdentity, emptyHeldRowFacts, parseItemString, recordHeldRow, sumBinding, type HeldRowFacts } from "../src/heldItemIdentity.ts";

function rows(...refs: Array<[string, string | undefined]>): HeldRowFacts {
  const facts = emptyHeldRowFacts();
  for (const [ref, bound] of refs) recordHeldRow(facts, parseItemString(ref)!, bound);
  return facts;
}

test("normalization blanks only linkLevel and specID, then strips trailing empty fields", () => {
  assert.deepEqual(parseItemString("item:188213::::::::78:1467:::::::::"), { kind: "FULL", normalized: "item:188213" });
  assert.deepEqual(parseItemString("item:188213::::::::85:253:::::::::"), { kind: "FULL", normalized: "item:188213" });
  // Everything after specID is preserved exactly, including bonus-ID order and modifier pairs.
  assert.deepEqual(parseItemString("item:235962::::::::78:1467::18:1:6710:2:9:65:28:181:::::"), { kind: "FULL", normalized: "item:235962:::::::::::18:1:6710:2:9:65:28:181" });
  assert.deepEqual(parseItemString("item:235962::::::::85:253::18:1:6710:2:9:65:28:181:::::"), parseItemString("item:235962::::::::78:1467::18:1:6710:2:9:65:28:181:::::"));
  // Fields before linkLevel (enchant, gems, suffix, uniqueID) are item facts and are kept.
  assert.deepEqual(parseItemString("item:19019:1900:::::::60:::::"), { kind: "FULL", normalized: "item:19019:1900" });
});

test("no field other than linkLevel/specID is rewritten: '' and '0' stay distinct, bonus IDs are not reordered", () => {
  const empty = parseItemString("item:100::::::::70::::::")!;
  const zero = parseItemString("item:100::::::::70:::0:::")!;
  assert.notDeepEqual(empty, zero);
  const ordered = parseItemString("item:100::::::::70:::::2:10:20")!;
  const reversed = parseItemString("item:100::::::::70:::::2:20:10")!;
  assert.notDeepEqual(ordered, reversed);
});

test("a bare item:<id> is incomplete, not an empty full string; non-item refs are not item strings", () => {
  assert.deepEqual(parseItemString("item:2589"), { kind: "BARE" });
  // A full string that normalizes to the same TEXT as a bare ref is still a full string.
  assert.deepEqual(parseItemString("item:2589::::::::70:::::::::"), { kind: "FULL", normalized: "item:2589" });
  assert.equal(parseItemString(undefined), undefined);
  assert.equal(parseItemString(""), undefined);
  assert.equal(parseItemString("battlepet:42"), undefined);
});

test("classification: UNIFORM, VARIANTS (precedence over incomplete), INCOMPLETE, NONE_HELD", () => {
  assert.deepEqual(classifyItemStringIdentity([rows(["item:1::::::::78:1467", "no"], ["item:1::::::::85:253", "no"])]), { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 });
  assert.deepEqual(classifyItemStringIdentity([rows(["item:1::::::::70:::::1:100", "no"]), rows(["item:1::::::::70:::::1:200", "no"])]), { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 });
  assert.deepEqual(classifyItemStringIdentity([rows(["item:1::::::::70:::::1:100", "no"], ["item:1::::::::70:::::1:200", "no"], ["item:1", "no"])]), { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 });
  assert.deepEqual(classifyItemStringIdentity([rows(["item:1::::::::70", "no"], ["item:1", "no"])]), { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount: 1 });
  assert.deepEqual(classifyItemStringIdentity([rows(["item:1", "no"])]), { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount: 0 });
  assert.deepEqual(classifyItemStringIdentity([]), { class: "NONE_HELD", distinctItemStringCount: 0 });
});

test("no safe-list: differing modifier 28 or modifier 38 values, or itemContext, are variants", () => {
  const mod28 = [rows(["item:200::::::::80:::::0:1:28:2000", "no"]), rows(["item:200::::::::80:::::0:1:28:2001", "no"])];
  assert.equal(classifyItemStringIdentity(mod28).class, "ITEM_STRING_VARIANTS");
  const mod38 = [rows(["item:200::::::::80:::::0:1:38:5", "no"], ["item:200::::::::80:::::0:1:38:6", "no"])];
  assert.equal(classifyItemStringIdentity(mod38).class, "ITEM_STRING_VARIANTS");
  const context = [rows(["item:200::::::::80:::13", "no"], ["item:200::::::::80:::35", "no"])];
  assert.equal(classifyItemStringIdentity(context).class, "ITEM_STRING_VARIANTS");
});

test("binding: yes -> bound, no -> unbound, ? / missing / unexpected -> unknown; counts are rows, not quantities", () => {
  assert.equal(bindingState("yes"), "BOUND");
  assert.equal(bindingState("no"), "UNBOUND");
  assert.equal(bindingState(undefined), "UNKNOWN");
  assert.equal(bindingState("?"), "UNKNOWN");
  assert.equal(bindingState("Warbound"), "UNKNOWN");
  assert.deepEqual(sumBinding([rows(["item:1::::::::70", "yes"], ["item:1::::::::70", "no"]), rows(["item:1::::::::70", undefined])]), { boundRowCount: 1, unboundRowCount: 1, unknownRowCount: 1 });
});
