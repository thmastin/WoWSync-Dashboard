// Keyboard behaviour of the modal dialogs: Tab / Shift+Tab wrap inside the dialog. (Escape handling and focus
// restoration were verified in a real browser; the decision of where focus goes next is the pure part.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextFocusIndex } from "../src/useDialogBehavior.ts";

test("Tab moves forward and wraps from the last element to the first", () => {
  assert.equal(nextFocusIndex(3, 0, false), 1);
  assert.equal(nextFocusIndex(3, 1, false), 2);
  assert.equal(nextFocusIndex(3, 2, false), 0);
});

test("Shift+Tab moves backward and wraps from the first element to the last", () => {
  assert.equal(nextFocusIndex(3, 2, true), 1);
  assert.equal(nextFocusIndex(3, 0, true), 2);
});

test("focus that is outside the dialog enters it at the edge in the direction of travel", () => {
  assert.equal(nextFocusIndex(3, -1, false), 0);
  assert.equal(nextFocusIndex(3, -1, true), 2);
});

test("a dialog with one focusable element keeps focus on it; with none there is nothing to move to", () => {
  assert.equal(nextFocusIndex(1, 0, false), 0);
  assert.equal(nextFocusIndex(1, 0, true), 0);
  assert.equal(nextFocusIndex(0, -1, false), -1);
});
