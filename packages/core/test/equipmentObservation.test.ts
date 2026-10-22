// Slice A: the pure equipment-observation layer (structural validation, slot normalization, the canonical
// sidecar vs latestExport projection policy, canonical JSON). Test names carry the A-IDs of the Slice A contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, evaluateEquipmentPolicy, normalizeEquipmentObservation } from "../src/equipmentObservation.ts";
import { VIREK_ROSTER, VIREK_SLOTS, VIREK_TUPLE, envelope, observation, sidecar } from "./equipmentObservationFixtures.ts";

const normalized = (input: unknown, version = "retail") => {
  const result = normalizeEquipmentObservation(input, version);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).value;
};
const rejected = (input: unknown, version = "retail") => {
  const result = normalizeEquipmentObservation(input, version);
  assert.equal(result.ok, false, `expected rejection of ${JSON.stringify(input)}`);
  return (result as Extract<typeof result, { ok: false }>).outcome;
};

test("A01 exact 7958c56 envelope (Virek) normalizes with tuple 1791375064/29/220", () => {
  const value = normalized(observation({ projection: true }));
  assert.equal(value.observedAt, 1791375064);
  assert.equal(value.capture, 29);
  assert.equal(value.revision, 220);
  assert.equal(value.completeness, "complete");
  assert.equal(value.source, "client");
  assert.equal(value.changedAt, 1791375064);
  assert.equal(value.reason, undefined);
  assert.deepEqual(value.slots, VIREK_SLOTS);
});

test("A02 exact sidecar field names and types are kept verbatim (clientFamily, classID, roster state/specializations, link)", () => {
  const input = observation();
  const value = normalized(input);
  assert.deepEqual(value.specEquipmentObservation, (input.envelope as any).specEquipmentObservation);
  const s = value.specEquipmentObservation as any;
  assert.equal(s.contractVersion, 1);
  assert.equal(s.clientFamily, "Retail");
  assert.equal(s.atomicity, "NOT_CLAIMED");
  assert.equal(s.readiness, "READY");
  assert.equal(s.classID, 3);
  assert.equal(s.stability, "STABLE");
  assert.deepEqual(s.roster, VIREK_ROSTER);
  assert.equal(s.activeSpecBefore.specID, 253);
  assert.equal(s.activeSpecAfter.specID, 253);
  assert.deepEqual(s.equipmentObservation, { ...VIREK_TUPLE });
});

test("A11 roster isUnlocked=false is kept as false", () => {
  const s = normalized(observation()).specEquipmentObservation as any;
  const survival = s.roster.specializations.find((row: any) => row.specID === 255);
  assert.equal(survival.isUnlocked, false);
  assert.ok("isUnlocked" in survival);
});

test("A12 omitted nil fields stay absent, never 0/false/empty", () => {
  const s = normalized(observation({ readiness: "NOT_READY" })).specEquipmentObservation as any;
  assert.deepEqual(s.activeSpecBefore, {}, "an unread active spec is {} - no specID, index, name, role, primaryStat or isUnlocked");
  assert.deepEqual(s.activeSpecAfter, {});
  assert.deepEqual(s.roster, { state: "NOT_READY" }, "no specializations key invented");
  const ready = normalized(observation()).specEquipmentObservation as any;
  const marksmanship = ready.roster.specializations.find((row: any) => row.specID === 254);
  assert.equal("isUnlocked" in marksmanship, false, "nil isUnlocked stays absent");
  const noClass = observation();
  delete ((noClass.envelope as any).specEquipmentObservation as any).classID;
  assert.equal("classID" in (normalized(noClass).specEquipmentObservation as any), false);
  const value = normalized(observation());
  assert.equal("reason" in value, false, "a complete envelope has no reason key");
});

test("A32 a non-integer, non-finite, negative or missing envelope tuple is invalid-or-unsupported", () => {
  const cases: Array<[string, unknown]> = [
    ["observedAt", "1791375064"],
    ["observedAt", 1791375064.5],
    ["observedAt", Infinity],
    ["capture", Number.NaN],
    ["capture", undefined],
    ["revision", -1],
    ["revision", 2 ** 53],
    ["revision", null],
  ];
  for (const [field, value] of cases) {
    const input = observation();
    if (value === undefined) delete (input.envelope as any)[field];
    else (input.envelope as any)[field] = value;
    assert.equal(rejected(input), "invalid-or-unsupported", `${field}=${String(value)}`);
  }
});

test("A32 other structural rejections: completeness, envelope, data/slots, optional field types, sidecar contract", () => {
  const variants: Array<[string, (o: any) => void]> = [
    ["completeness unknown", (o) => (o.envelope.completeness = "unknown")],
    ["completeness missing", (o) => delete o.envelope.completeness],
    ["envelope array", (o) => (o.envelope = [])],
    ["data missing", (o) => delete o.envelope.data],
    ["slots missing", (o) => (o.envelope.data = {})],
    ["slots string", (o) => (o.envelope.data = { slots: "x" })],
    ["reason number", (o) => (o.envelope.reason = 5)],
    ["source object", (o) => (o.envelope.source = {})],
    ["changedAt fractional", (o) => (o.envelope.changedAt = 1.5)],
    ["sidecar array", (o) => (o.envelope.specEquipmentObservation = [])],
    ["sidecar contractVersion 2", (o) => (o.envelope.specEquipmentObservation.contractVersion = 2)],
    ["sidecar clientFamily Classic", (o) => (o.envelope.specEquipmentObservation.clientFamily = "Classic")],
    ["sidecar link missing", (o) => delete o.envelope.specEquipmentObservation.equipmentObservation],
    ["sidecar link not an object", (o) => (o.envelope.specEquipmentObservation.equipmentObservation = 1791375064)],
    ["projection not an object", (o) => (o.projection = "STABLE")],
  ];
  for (const [label, mutate] of variants) {
    const input = observation();
    mutate(input);
    assert.equal(rejected(input), "invalid-or-unsupported", label);
  }
  assert.equal(rejected(null), "invalid-or-unsupported");
  assert.equal(rejected({}), "invalid-or-unsupported");
});

test("A31 a non-Retail version is invalid-or-unsupported whatever the payload says", () => {
  for (const version of ["classic-era", "tbc-anniversary", "forever", "unknown-version"]) {
    assert.equal(rejected(observation(), version), "invalid-or-unsupported", version);
  }
});

test("A39 a gapless 0-based array and a gapped slot-keyed object normalize without shifting WoW slot numbers", () => {
  const head = { itemID: 1 };
  const neck = { itemID: 2 };
  const shoulder = { itemID: 3 };
  const array = normalized(observation({ slots: [head, neck, shoulder] })).slots;
  assert.deepEqual(array, { "1": head, "2": neck, "3": shoulder }, "JS index 0 is WoW slot 1");
  const object = normalized(observation({ slots: { "1": head, "2": neck, "3": shoulder } })).slots;
  assert.deepEqual(array, object);
  const full = Array.from({ length: 19 }, (_, i) => ({ itemID: 1000 + i + 1 }));
  const fullSlots = normalized(observation({ slots: full })).slots;
  assert.deepEqual(Object.keys(fullSlots), Array.from({ length: 19 }, (_, i) => String(i + 1)));
  assert.equal((fullSlots["19"] as any).itemID, 1019);
  const gapped = normalized(observation({ slots: { "1": head, "16": { itemID: 16 }, "19": { itemID: 19 } } })).slots;
  assert.deepEqual(Object.keys(gapped).sort(), ["1", "16", "19"]);
  assert.equal((gapped["16"] as any).itemID, 16);
  assert.deepEqual(normalized(observation({ slots: {} })).slots, {}, "an empty Lua table arrives as {}");
  for (const bad of [{ "0": head }, { "20": head }, { "01": head }, { head }, Array.from({ length: 20 }, () => head)]) {
    assert.equal(rejected(observation({ slots: bad })), "invalid-or-unsupported", JSON.stringify(Object.keys(bad)));
  }
});

test("A41 lastAttemptAt / lastAttemptError never reach the normalized evidence", () => {
  const value = normalized(observation({ lastAttempt: true })) as unknown as Record<string, unknown>;
  assert.equal("lastAttemptAt" in value, false);
  assert.equal("lastAttemptError" in value, false);
  assert.deepEqual(value, normalized(observation()) as unknown as Record<string, unknown>);
});

test("A44 canonicalJson is recursively key-order independent and keeps array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: [2, { b: 1, a: 0 }], x: false } }), canonicalJson({ a: { x: false, y: [2, { a: 0, b: 1 }] }, z: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ a: false }), '{"a":false}');
});

test("A03/A04/A42 policy A, B and E accept; A05 policy C and A06 policy D reject", () => {
  const canonical = normalized(observation());
  assert.deepEqual(evaluateEquipmentPolicy(canonical, undefined), { ok: true }, "A: canonical, no projection");
  const reordered = Object.fromEntries(Object.entries(sidecar()).reverse());
  assert.deepEqual(evaluateEquipmentPolicy(canonical, reordered), { ok: true }, "B: equivalent projection, key order irrelevant");
  assert.deepEqual(evaluateEquipmentPolicy(canonical, sidecar(VIREK_TUPLE, { stability: "UNSTABLE", afterSpecID: 254 })), { ok: false, outcome: "projection-mismatch" }, "C");
  assert.deepEqual(evaluateEquipmentPolicy(canonical, sidecar({ ...VIREK_TUPLE, revision: 219 })), { ok: false, outcome: "projection-mismatch" }, "C: a projection of an older envelope");
  const bare = normalized(observation({ withSidecar: false }));
  assert.deepEqual(evaluateEquipmentPolicy(bare, undefined), { ok: true }, "E: no sidecar either side");
  assert.deepEqual(evaluateEquipmentPolicy(bare, sidecar()), { ok: false, outcome: "projection-without-canonical" }, "D: envelope without sidecar");
  assert.equal(rejected({ projection: sidecar() }), "projection-without-canonical", "D: no envelope at all");
  assert.equal(rejected({ envelope: envelope({ withSidecar: false }), projection: "x" }), "invalid-or-unsupported", "a malformed projection is structural");
});
