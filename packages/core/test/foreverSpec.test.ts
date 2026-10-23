import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveForeverSpec, foreverSpecProjection } from "../src/foreverSpec.ts";

test("DERIVED spec selects the clear leading talent tree", () => {
  assert.equal(deriveForeverSpec([{ name: "Tree A", pointsSpent: 21 }, { name: "Tree B", pointsSpent: 10 }, { name: "Tree C", pointsSpent: 0 }], 60), "Tree A");
});

test("near-even top trees stay UNDETERMINED at a one-point gap", () => {
  assert.equal(deriveForeverSpec([{ name: "Tree A", pointsSpent: 20 }, { name: "Tree B", pointsSpent: 19 }], 60), "UNDETERMINED");
});

test("characters below level 10 stay UNDETERMINED", () => {
  assert.equal(deriveForeverSpec([{ name: "Tree A", pointsSpent: 4 }, { name: "Tree B", pointsSpent: 0 }], 9), "UNDETERMINED");
});

test("missing talent data or incomplete points stay UNDETERMINED", () => {
  assert.equal(deriveForeverSpec(undefined, 60), "UNDETERMINED");
  assert.equal(deriveForeverSpec([], 60), "UNDETERMINED");
  assert.equal(deriveForeverSpec([{ name: "Tree A", pointsSpent: 20 }, { name: "Tree B" }], 60), "UNDETERMINED");
});

test("planned spec overrides display only, retaining separate DERIVED and USER_CONFIGURED values", () => {
  const result = foreverSpecProjection("Tree A", "Tree C");
  assert.deepEqual(result, {
    derived: { value: "Tree A", provenance: "DERIVED", rule: "Tree with the most pointsSpent; UNDETERMINED below level 10, without complete talent point data, or when the leading trees differ by at most 1 point." },
    planned: { value: "Tree C", provenance: "USER_CONFIGURED" },
    display: "Tree C",
  });
});
