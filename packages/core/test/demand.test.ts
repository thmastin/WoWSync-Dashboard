// Explicit Demand: pure domain rules only (validation, conflict key, stored<->domain conversion).
// Persistence behavior (uniqueness enforcement, lifecycle transitions) is covered in demandStore.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DemandValidationError,
  commodityIdentity,
  demandConflictKey,
  storedDemandToExplicitDemand,
  validateCreateDemandInput,
  validateUpdateDemandInput,
  type StoredDemand,
} from "../src/demand.ts";

test("commodityIdentity requires a positive integer base item id", () => {
  assert.deepEqual(commodityIdentity(12345), { kind: "commodity", gameVersion: "retail", baseItemId: 12345 });
  assert.throws(() => commodityIdentity(0), TypeError);
  assert.throws(() => commodityIdentity(-1), TypeError);
  assert.throws(() => commodityIdentity(1.5), TypeError);
});

test("demandConflictKey is stable for the same (version, type, item) and distinguishes different ones", () => {
  const a = demandConflictKey("retail", "STOCK_TARGET", 100);
  const b = demandConflictKey("retail", "STOCK_TARGET", 100);
  const c = demandConflictKey("retail", "STOCK_TARGET", 200);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("validateCreateDemandInput accepts a minimal valid STOCK_TARGET request and defaults the demand type", () => {
  const result = validateCreateDemandInput({ baseItemId: 500, requiredQuantity: 10 });
  assert.deepEqual(result, { demandType: "STOCK_TARGET", baseItemId: 500, requiredQuantity: 10, purpose: undefined });
});

test("validateCreateDemandInput rejects anything other than STOCK_TARGET rather than silently coercing it", () => {
  assert.throws(
    () => validateCreateDemandInput({ baseItemId: 500, requiredQuantity: 10, demandType: "BOGUS" as never }),
    (err: unknown) => err instanceof DemandValidationError && err.code === "UNSUPPORTED_DEMAND_TYPE",
  );
});

test("validateCreateDemandInput rejects a non-positive or non-integer base item id", () => {
  for (const baseItemId of [0, -5, 1.5]) {
    assert.throws(
      () => validateCreateDemandInput({ baseItemId, requiredQuantity: 10 }),
      (err: unknown) => err instanceof DemandValidationError && err.code === "INVALID_BASE_ITEM_ID",
    );
  }
});

test("validateCreateDemandInput rejects a negative or non-integer required quantity, but allows zero", () => {
  assert.doesNotThrow(() => validateCreateDemandInput({ baseItemId: 500, requiredQuantity: 0 }));
  for (const requiredQuantity of [-1, 1.5]) {
    assert.throws(
      () => validateCreateDemandInput({ baseItemId: 500, requiredQuantity }),
      (err: unknown) => err instanceof DemandValidationError && err.code === "INVALID_REQUIRED_QUANTITY",
    );
  }
});

test("validateCreateDemandInput rejects an overlong purpose", () => {
  assert.throws(
    () => validateCreateDemandInput({ baseItemId: 500, requiredQuantity: 10, purpose: "x".repeat(501) }),
    (err: unknown) => err instanceof DemandValidationError && err.code === "INVALID_PURPOSE",
  );
});

test("validateUpdateDemandInput allows an empty update and rejects invalid fields the same way creation does", () => {
  assert.deepEqual(validateUpdateDemandInput({}), {});
  assert.throws(() => validateUpdateDemandInput({ requiredQuantity: -1 }), (err: unknown) => err instanceof DemandValidationError);
  assert.throws(() => validateUpdateDemandInput({ purpose: "x".repeat(501) }), (err: unknown) => err instanceof DemandValidationError);
});

test("storedDemandToExplicitDemand round-trips every field, omitting purpose/supersedesStableId when absent", () => {
  const stored: StoredDemand = {
    stableId: "demand_1",
    gameVersion: "retail",
    demandType: "STOCK_TARGET",
    baseItemId: 777,
    requiredQuantity: 10,
    status: "ACTIVE",
    createdAt: 1000,
    updatedAt: 1000,
  };
  const domain = storedDemandToExplicitDemand(stored);
  assert.deepEqual(domain, {
    stableId: "demand_1",
    gameVersion: "retail",
    demandType: "STOCK_TARGET",
    commodity: { kind: "commodity", gameVersion: "retail", baseItemId: 777 },
    requiredQuantity: 10,
    status: "ACTIVE",
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.ok(!("purpose" in domain));
  assert.ok(!("supersedesStableId" in domain));
});

test("storedDemandToExplicitDemand carries purpose and supersedesStableId when present", () => {
  const domain = storedDemandToExplicitDemand({
    stableId: "demand_2",
    gameVersion: "retail",
    demandType: "STOCK_TARGET",
    baseItemId: 777,
    requiredQuantity: 10,
    purpose: "Raid consumables",
    status: "INACTIVE",
    supersedesStableId: "demand_1",
    createdAt: 1000,
    updatedAt: 2000,
  });
  assert.equal(domain.purpose, "Raid consumables");
  assert.equal(domain.supersedesStableId, "demand_1");
  assert.equal(domain.status, "INACTIVE");
});
