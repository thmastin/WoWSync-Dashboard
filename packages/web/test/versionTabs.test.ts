import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_THRESHOLD_SECONDS } from "@wowsync-dashboard/core/freshness.ts";
import { pickDefaultVersion, versionTabDotTitle, versionTabMeta } from "../src/versionTabs.ts";

const NOW = 1_700_000_000;

test("pickDefaultVersion: valid stored preference wins over freshest", () => {
  const summaries = [
    { version: "retail", characterCount: 5, lastUpdatedAt: NOW },
    { version: "tbc-anniversary", characterCount: 1, lastUpdatedAt: NOW - 10 },
  ];
  assert.equal(pickDefaultVersion(summaries, "classic-era"), "classic-era");
  assert.equal(pickDefaultVersion(summaries, "tbc-anniversary"), "tbc-anniversary");
});

test("pickDefaultVersion: ignores invalid or unknown-version stored values", () => {
  const summaries = [
    { version: "retail", characterCount: 2, lastUpdatedAt: NOW - 100 },
    { version: "forever", characterCount: 1, lastUpdatedAt: NOW },
  ];
  assert.equal(pickDefaultVersion(summaries, "unknown-version"), "forever");
  assert.equal(pickDefaultVersion(summaries, "not-a-version"), "forever");
  assert.equal(pickDefaultVersion(summaries, null), "forever");
  assert.equal(pickDefaultVersion(summaries, undefined), "forever");
});

test("pickDefaultVersion: chooses max lastUpdatedAt among known versions", () => {
  const summaries = [
    { version: "classic-era", characterCount: 3, lastUpdatedAt: NOW - 50 },
    { version: "tbc-anniversary", characterCount: 9, lastUpdatedAt: NOW - 10 },
    { version: "retail", characterCount: 1, lastUpdatedAt: NOW - 100 },
    { version: "forever", characterCount: 0 },
    { version: "unknown-version", characterCount: 99, lastUpdatedAt: NOW + 999 },
  ];
  assert.equal(pickDefaultVersion(summaries), "tbc-anniversary");
});

test("pickDefaultVersion: never returns unknown-version even if it is the only timestamped row", () => {
  const summaries = [
    { version: "unknown-version", characterCount: 5, lastUpdatedAt: NOW },
    { version: "classic-era", characterCount: 0 },
    { version: "retail", characterCount: 0 },
  ];
  assert.equal(pickDefaultVersion(summaries), "retail");
});

test("pickDefaultVersion: with no timestamps, prefers first version that has characters", () => {
  const summaries = [
    { version: "classic-era", characterCount: 0 },
    { version: "tbc-anniversary", characterCount: 2 },
    { version: "retail", characterCount: 4 },
    { version: "forever", characterCount: 1 },
  ];
  assert.equal(pickDefaultVersion(summaries), "tbc-anniversary");
});

test("pickDefaultVersion: all empty falls back to retail, not tbc-anniversary", () => {
  const summaries = [
    { version: "classic-era", characterCount: 0 },
    { version: "tbc-anniversary", characterCount: 0 },
    { version: "retail", characterCount: 0 },
    { version: "forever", characterCount: 0 },
  ];
  assert.equal(pickDefaultVersion(summaries), "retail");
  assert.equal(pickDefaultVersion([]), "retail");
});

test("versionTabMeta: count and freshness from lastUpdatedAt", () => {
  assert.deepEqual(
    versionTabMeta({ version: "retail", characterCount: 8, lastUpdatedAt: NOW - 60 }, NOW),
    { count: 8, freshness: "recent" },
  );
  assert.deepEqual(
    versionTabMeta(
      { version: "retail", characterCount: 3, lastUpdatedAt: NOW - RECENT_THRESHOLD_SECONDS - 1 },
      NOW,
    ),
    { count: 3, freshness: "stale" },
  );
  assert.deepEqual(
    versionTabMeta({ version: "forever", characterCount: 0 }, NOW),
    { count: 0, freshness: "unknown" },
  );
  assert.deepEqual(versionTabMeta(undefined, NOW), { count: 0, freshness: "unknown" });
});

test("versionTabDotTitle: color legend for each freshness", () => {
  const days = Math.round(RECENT_THRESHOLD_SECONDS / 86400);
  assert.equal(versionTabDotTitle("recent"), `Green: last sync for this version within ${days} days`);
  assert.equal(versionTabDotTitle("stale"), `Yellow: last sync for this version older than ${days} days`);
  assert.equal(versionTabDotTitle("unknown"), "Gray: no sync observed for this version yet");
});
