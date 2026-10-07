import { test } from "node:test";
import assert from "node:assert";
import {
  normalizeEquipmentObservation,
  canonicalJson,
  evaluateEquipmentPolicy,
  type CapturedEquipmentObservation,
} from "../src/equipmentObservation.ts";

test("A01: exact envelope normalizes", () => {
  const input = {
    envelope: {
      observedAt: 1791375064,
      capture: 29,
      revision: 220,
      completeness: "complete",
      data: {
        slots: {
          "1": { itemID: 123 },
          "2": null,
          "3": { itemID: 456 },
        },
      },
      specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail" },
    },
  };

  const result = normalizeEquipmentObservation(input, "retail");
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.value.observedAt, 1791375064);
    assert.strictEqual(result.value.capture, 29);
    assert.strictEqual(result.value.revision, 220);
    assert.strictEqual(result.value.completeness, "complete");
  }
});

test("A02: sidecar field names/types kept verbatim", () => {
  const input = {
    envelope: {
      observedAt: 123456789,
      capture: 5,
      revision: 100,
      completeness: "partial",
      reason: "Item metadata pending",
      data: { slots: {} },
      specEquipmentObservation: {
        contractVersion: 1,
        clientFamily: "Retail",
        classID: 3,
        roster: { state: "OBSERVED", specializations: [] },
        activeSpecBefore: { specID: 253 },
        activeSpecAfter: { specID: 254 },
        stability: "UNSTABLE",
      },
    },
  };

  const result = normalizeEquipmentObservation(input, "retail");
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    const sidecar = result.value.specEquipmentObservation as any;
    assert.strictEqual(sidecar.contractVersion, 1);
    assert.strictEqual(sidecar.clientFamily, "Retail");
    assert.strictEqual(sidecar.classID, 3);
  }
});

test("A39: luaToPlain slot shapes normalize identically", () => {
  // 0-based JS array: index i means slot i+1
  const arrayForm = {
    envelope: {
      observedAt: 100,
      capture: 1,
      revision: 1,
      completeness: "complete",
      data: { slots: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    },
  };

  // String-keyed object: direct 1-based keys
  const objectForm = {
    envelope: {
      observedAt: 100,
      capture: 1,
      revision: 1,
      completeness: "complete",
      data: { slots: { "1": { id: 1 }, "2": { id: 2 }, "3": { id: 3 } } },
    },
  };

  const resArray = normalizeEquipmentObservation(arrayForm, "retail");
  const resObject = normalizeEquipmentObservation(objectForm, "retail");

  assert.strictEqual(resArray.ok, true);
  assert.strictEqual(resObject.ok, true);

  if (resArray.ok && resObject.ok) {
    // Both should have identical slots after normalization
    assert.deepStrictEqual(resArray.value.slots, resObject.value.slots);
  }
});

test("A11: explicit false is kept", () => {
  const input = {
    envelope: {
      observedAt: 100,
      capture: 1,
      revision: 1,
      completeness: "complete",
      data: { slots: {} },
      specEquipmentObservation: {
        contractVersion: 1,
        clientFamily: "Retail",
        roster: {
          state: "OBSERVED",
          specializations: [{ index: 1, specID: 253, isUnlocked: false }],
        },
        activeSpecBefore: {},
        activeSpecAfter: {},
      },
    },
  };

  const result = normalizeEquipmentObservation(input, "retail");
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    const sidecar = result.value.specEquipmentObservation as any;
    const spec = sidecar.roster.specializations[0];
    assert.strictEqual(spec.isUnlocked, false);
  }
});

test("A44: canonicalJson is key-order independent", () => {
  const obj1 = { z: 1, a: 2, m: 3 };
  const obj2 = { a: 2, m: 3, z: 1 };

  const json1 = canonicalJson(obj1);
  const json2 = canonicalJson(obj2);

  assert.strictEqual(json1, json2);
});

test("Policy B: equivalent projection accepted", () => {
  const canonical: CapturedEquipmentObservation = {
    observedAt: 100,
    capture: 1,
    revision: 1,
    completeness: "complete",
    slots: {},
    specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
  };

  const projection = { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" };

  const result = evaluateEquipmentPolicy(canonical, projection);
  assert.deepStrictEqual(result, { ok: true });
});

test("Policy C: differing projection rejected", () => {
  const canonical: CapturedEquipmentObservation = {
    observedAt: 100,
    capture: 1,
    revision: 1,
    completeness: "complete",
    slots: {},
    specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", stability: "STABLE" },
  };

  const projection = { contractVersion: 1, clientFamily: "Retail", stability: "UNSTABLE" };

  const result = evaluateEquipmentPolicy(canonical, projection);
  assert.deepStrictEqual(result, { ok: false, outcome: "projection-mismatch" });
});

test("Policy E: no sidecar accepted", () => {
  const canonical: CapturedEquipmentObservation = {
    observedAt: 100,
    capture: 1,
    revision: 1,
    completeness: "complete",
    slots: {},
  };

  const result = evaluateEquipmentPolicy(canonical, undefined);
  assert.deepStrictEqual(result, { ok: true });
});
