import assert from "node:assert/strict";
import test from "node:test";
import { resolvePackageReservationSource, reviewPackageReservations, reviewPackageSourceDemand } from "../src/erpFulfillmentPackageReview.ts";

const source = "forever::beta-pvp-2::Player-4613-TEST";
const resourceKey = "ITEM_REF:forever:item:2901";

test("package review aggregates same-source requests and detects a combined reservation conflict", () => {
  const [group] = reviewPackageReservations([
    { taskKey: "project-a:ore", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 2, availableObservedLowerBound: 3 },
    { taskKey: "project-b:ore", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 2, availableObservedLowerBound: 3 },
  ]);
  assert.equal(group?.requestedQuantity, 4);
  assert.equal(group?.availableObservedLowerBound, 3);
  assert.equal(group?.state, "EXCEEDS_OBSERVED_LOWER_BOUND");
  assert.equal(group?.taskCount, 2);
});

test("package review keeps different versions, sources, resource variants, and unknown scopes separate", () => {
  const groups = reviewPackageReservations([
    { taskKey: "a", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "b", version: "retail", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "c", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: "forever::other::Player-OTHER", quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "d", version: "forever", kind: "ITEM_REF", resourceKey: `${resourceKey}:variant-2`, sourceIdentityKey: source, quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "e", version: "forever", kind: "ITEM_REF", resourceKey, quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "f", version: "forever", kind: "ITEM_REF", resourceKey, quantity: 1, availableObservedLowerBound: 2 },
  ]);
  assert.equal(groups.length, 6);
  assert.equal(groups.filter((group) => group.state === "WITHIN_OBSERVED_LOWER_BOUND").length, 6);
  assert.equal(groups.filter((group) => group.sourceLabel === "UNKNOWN source (kept separate)").length, 2);
});

test("conflicting or absent source bounds remain non-confirming", () => {
  const groups = reviewPackageReservations([
    { taskKey: "a", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 1, availableObservedLowerBound: 3 },
    { taskKey: "b", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, quantity: 1, availableObservedLowerBound: 2 },
    { taskKey: "c", version: "forever", kind: "ITEM_REF", resourceKey: "other", sourceIdentityKey: source, quantity: 1 },
  ]);
  assert.deepEqual(groups.map((group) => group.state), ["CONFLICTING_EVIDENCE", "UNKNOWN"]);
});

test("an unavailable alternate reservation source remains UNKNOWN and never falls back to the requirement source", () => {
  assert.deepEqual(resolvePackageReservationSource({ selectedAlternateIdentityKey: "forever::realm::alternate", needSourceIdentityKey: source, needSourceLowerBound: 9 }), { sourceIdentityKey: "forever::realm::alternate" });
});

test("selected source review compares combined recent shortfalls with exact source lower bounds", () => {
  const [group] = reviewPackageSourceDemand([
    { taskKey: "a", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", sourceObservedAt: 100, requestedNeedQuantity: 2, availableObservedLowerBound: 3 },
    { taskKey: "b", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", sourceObservedAt: 101, requestedNeedQuantity: 2, availableObservedLowerBound: 3 },
  ]);
  assert.equal(group?.requestedNeedQuantity, 4);
  assert.equal(group?.availableObservedLowerBound, 3);
  assert.equal(group?.state, "EXCEEDS_OBSERVED_LOWER_BOUND");
});

test("source review keeps uncertain need, missing quantity, and conflicting source views explicit", () => {
  const groups = reviewPackageSourceDemand([
    { taskKey: "a", version: "forever", kind: "ITEM_REF", resourceKey, sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", availableObservedLowerBound: 3 },
    { taskKey: "b", version: "forever", kind: "ITEM_REF", resourceKey: "unknown-supply", sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", requestedNeedQuantity: 1 },
    { taskKey: "c", version: "forever", kind: "ITEM_REF", resourceKey: "conflict", sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", requestedNeedQuantity: 1, availableObservedLowerBound: 3 },
    { taskKey: "d", version: "forever", kind: "ITEM_REF", resourceKey: "conflict", sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "recent", requestedNeedQuantity: 1, availableObservedLowerBound: 2 },
  ]);
  assert.deepEqual(groups.map((group) => group.state), ["UNKNOWN_NEED", "UNKNOWN_SOURCE_QUANTITY", "CONFLICTING_SOURCE_EVIDENCE"]);
  const stale = reviewPackageSourceDemand([{ taskKey: "stale", version: "forever", kind: "ITEM_REF", resourceKey: "stale", sourceIdentityKey: source, sourceName: "Hallo", sourceFreshness: "stale", sourceObservedAt: 50, requestedNeedQuantity: 1, availableObservedLowerBound: 3 }]);
  assert.equal(stale[0]?.state, "STALE_OR_UNKNOWN_SOURCE_EVIDENCE");
  assert.equal(stale[0]?.sourceFreshness, "stale");
  assert.equal(stale[0]?.oldestSourceObservedAt, 50);
});
