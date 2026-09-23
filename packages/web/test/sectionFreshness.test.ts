import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionFreshnessCaption, sectionObservationAt } from "../src/sectionFreshness.ts";

const NOW = 1_700_000_000;

test("observation time prefers observedAt, else lastVisit", () => {
  assert.equal(sectionObservationAt({ state: "OBSERVED", observedAt: 10, lastVisit: 99 }), 10);
  assert.equal(sectionObservationAt({ state: "LAST_SEEN", lastVisit: 99 }), 99);
  assert.equal(sectionObservationAt({ state: "UNKNOWN" }), undefined);
});

test("UNKNOWN never gets a freshness caption", () => {
  assert.equal(
    sectionFreshnessCaption({ state: "UNKNOWN", observedAt: NOW - 100 }, NOW),
    null,
  );
});

test("LAST_SEEN uses as-of phrasing so it is not read as current", () => {
  const c = sectionFreshnessCaption(
    { state: "LAST_SEEN", observedAt: NOW - 9 * 86400 },
    NOW,
  );
  assert.deepEqual(c, { text: "as of 9d ago", at: NOW - 9 * 86400 });
});

test("LAST_SEEN falls back to lastVisit when observedAt is absent", () => {
  const c = sectionFreshnessCaption(
    { state: "LAST_SEEN", lastVisit: NOW - 3600 },
    NOW,
  );
  assert.deepEqual(c, { text: "as of 1h ago", at: NOW - 3600 });
});

test("OBSERVED with a timestamp shows observed age", () => {
  const c = sectionFreshnessCaption(
    { state: "OBSERVED", observedAt: NOW - 120 },
    NOW,
  );
  assert.deepEqual(c, { text: "observed 2m ago", at: NOW - 120 });
});

test("known state without a timestamp has no caption", () => {
  assert.equal(sectionFreshnessCaption({ state: "OBSERVED" }, NOW), null);
  assert.equal(sectionFreshnessCaption({ state: "LAST_SEEN" }, NOW), null);
});