import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidAdjustedReservationQuantity, maxAdjustedReservationQuantity } from "../src/components/erpReservationAdjustment.ts";

test("reservation edits may release units but cannot increase beyond remaining observed lower-bound supply", () => {
  const maximum = maxAdjustedReservationQuantity(4, 3);
  assert.equal(maximum, 7);
  assert.equal(isValidAdjustedReservationQuantity(2, 4, maximum), true);
  assert.equal(isValidAdjustedReservationQuantity(7, 4, maximum), true);
  assert.equal(isValidAdjustedReservationQuantity(8, 4, maximum), false);
  assert.equal(isValidAdjustedReservationQuantity(0, 4, maximum), false);
});

test("unknown supply permits reducing an existing reservation but never increasing it", () => {
  const maximum = maxAdjustedReservationQuantity(4, undefined);
  assert.equal(maximum, 4);
  assert.equal(isValidAdjustedReservationQuantity(1, 4, maximum), true);
  assert.equal(isValidAdjustedReservationQuantity(5, 4, maximum), false);
});

test("invalid or overflowing reservation arithmetic cannot widen the edit boundary", () => {
  assert.equal(maxAdjustedReservationQuantity(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
  assert.equal(maxAdjustedReservationQuantity(0, 5), 0);
  assert.equal(isValidAdjustedReservationQuantity(1.5, 1, 2), false);
});
