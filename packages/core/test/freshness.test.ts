import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFreshness, RECENT_THRESHOLD_SECONDS } from "../src/freshness.ts";

const NOW = 1_800_000_000;

test("a snapshot observed just now is recent", () => {
  assert.equal(classifyFreshness(NOW, NOW), "recent");
});

test("a snapshot observed exactly at the recent threshold is still recent", () => {
  assert.equal(classifyFreshness(NOW - RECENT_THRESHOLD_SECONDS, NOW), "recent");
});

test("a snapshot observed just past the recent threshold is stale", () => {
  assert.equal(classifyFreshness(NOW - RECENT_THRESHOLD_SECONDS - 1, NOW), "stale");
});

test("a snapshot observed a long time ago is stale, not unknown", () => {
  assert.equal(classifyFreshness(NOW - 365 * 24 * 3600, NOW), "stale");
});

test("no observation timestamp at all is unknown, never assumed recent or stale", () => {
  assert.equal(classifyFreshness(undefined, NOW), "unknown");
});

test("a future timestamp (clock skew) is treated as recent, not an error", () => {
  assert.equal(classifyFreshness(NOW + 1000, NOW), "recent");
});

test("classification is deterministic given the same (timestamp, now) pair", () => {
  const a = classifyFreshness(NOW - 1000, NOW);
  const b = classifyFreshness(NOW - 1000, NOW);
  assert.equal(a, b);
});
