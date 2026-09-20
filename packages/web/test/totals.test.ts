// How totals are worded: unknown is "?", never "0c"/"0m"; a real observed zero
// stays a real zero; stale and unobserved contributors are stated, never hidden.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoldFacts, PlaytimeFacts } from "../src/types.ts";
import { describeGoldTotal, describePlaytimeTotal, formatAge } from "../src/totals.ts";

const NOW = 1_790_000_000;
const gold = (over: Partial<GoldFacts>): GoldFacts => ({
  totalKnownCopper: 0,
  charactersWithKnownGold: 0,
  charactersWithUnknownGold: 0,
  staleCharactersWithKnownGold: 0,
  byCharacter: [],
  largestRecentChanges: [],
  ...over,
});
const playtime = (over: Partial<PlaytimeFacts>): PlaytimeFacts => ({
  totalKnownPlayedSeconds: 0,
  charactersWithKnownPlaytime: 0,
  staleCharactersWithKnownPlaytime: 0,
  byCharacter: [],
  ...over,
});

// --- unknown is not zero ------------------------------------------------------------------------------

test("no observed gold anywhere: the headline is '?' - never '0c' - and the basis says why", () => {
  const d = describeGoldTotal(gold({ totalKnownCopper: 0, charactersWithKnownGold: 0, charactersWithUnknownGold: 2 }), NOW);
  assert.equal(d.value, "?");
  assert.equal(d.known, false);
  assert.match(d.basis, /not observed for 2 characters/);
  assert.doesNotMatch(d.value, /0c/);
});

test("an empty scope says so instead of showing a total", () => {
  const d = describeGoldTotal(gold({}), NOW);
  assert.equal(d.value, "?");
  assert.equal(d.basis, "no characters yet");
});

test("an OBSERVED 0 copper is a real zero (known count 1, total 0)", () => {
  const d = describeGoldTotal(gold({ totalKnownCopper: 0, charactersWithKnownGold: 1, oldestKnownGoldObservedAt: NOW - 60 }), NOW);
  assert.equal(d.value, "0c");
  assert.equal(d.known, true);
});

test("the decision is by the known COUNT, never by total === 0 or truthiness", () => {
  assert.equal(describeGoldTotal(gold({ totalKnownCopper: 0, charactersWithKnownGold: 0 }), NOW).value, "?");
  assert.equal(describeGoldTotal(gold({ totalKnownCopper: 0, charactersWithKnownGold: 3 }), NOW).value, "0c");
  assert.equal(describeGoldTotal(gold({ totalKnownCopper: 12_345_678, charactersWithKnownGold: 3 }), NOW).value, "1234g 56s 78c");
});

// --- stale and unobserved contributors ----------------------------------------------------------------------------

test("all contributors recent: the basis names the count and the age of the oldest data, with no stale warning", () => {
  const d = describeGoldTotal(gold({ totalKnownCopper: 500, charactersWithKnownGold: 2, oldestKnownGoldObservedAt: NOW - 2 * 3600 }), NOW);
  assert.equal(d.basis, "from 2 characters · oldest data 2 h old");
  assert.equal(d.hasStale, false);
});

test("stale contributors are counted in the basis and flagged, but the total itself is unchanged", () => {
  const d = describeGoldTotal(
    gold({ totalKnownCopper: 999, charactersWithKnownGold: 3, staleCharactersWithKnownGold: 2, oldestKnownGoldObservedAt: NOW - 12 * 86400 }),
    NOW,
  );
  assert.equal(d.value, "9s 99c");
  assert.match(d.basis, /2 last synced over 3 d ago/);
  assert.match(d.basis, /oldest data 12 d old/);
  assert.equal(d.hasStale, true);
});

test("unobserved characters are stated as EXCLUDED, not counted as zero", () => {
  const d = describeGoldTotal(gold({ totalKnownCopper: 100, charactersWithKnownGold: 1, charactersWithUnknownGold: 2, oldestKnownGoldObservedAt: NOW - 30 }), NOW);
  assert.match(d.basis, /2 not observed \(not counted\)/);
  assert.match(d.basis, /^from 1 character ·/);
});

test("a realm whose only contributor is stale still shows the number, with the staleness in the basis (not as a hint that can be missed)", () => {
  const d = describeGoldTotal(gold({ totalKnownCopper: 5000, charactersWithKnownGold: 1, staleCharactersWithKnownGold: 1, oldestKnownGoldObservedAt: NOW - 20 * 86400 }), NOW);
  assert.equal(d.hasStale, true);
  assert.match(d.basis, /1 last synced over 3 d ago · oldest data 20 d old/);
});

// --- playtime -------------------------------------------------------------------------------------------------------------

test("playtime follows the same rules: '?' with none observed, real values otherwise", () => {
  assert.equal(describePlaytimeTotal(playtime({}), 2, NOW).value, "?");
  assert.equal(describePlaytimeTotal(playtime({}), 2, NOW).basis, "/played not observed for 2 characters");
  const d = describePlaytimeTotal(playtime({ totalKnownPlayedSeconds: 3 * 3600 + 120, charactersWithKnownPlaytime: 1, staleCharactersWithKnownPlaytime: 1, oldestKnownPlaytimeObservedAt: NOW - 5 * 86400 }), 2, NOW);
  assert.equal(d.value, "3h 2m");
  assert.match(d.basis, /1 not observed \(not counted\)/);
  assert.match(d.basis, /1 last synced over 3 d ago/);
});

test("an observed 0 seconds of playtime is a real zero", () => {
  assert.equal(describePlaytimeTotal(playtime({ totalKnownPlayedSeconds: 0, charactersWithKnownPlaytime: 1 }), 1, NOW).value, "0m");
});

// --- ages -----------------------------------------------------------------------------------------------------------------

test("formatAge is coarse and never rounds an age down to look fresher", () => {
  assert.equal(formatAge(0), "1 min");
  assert.equal(formatAge(59), "1 min");
  assert.equal(formatAge(3599), "59 min");
  assert.equal(formatAge(3600), "1 h");
  assert.equal(formatAge(86399), "23 h");
  assert.equal(formatAge(86400), "1 d");
  assert.equal(formatAge(20 * 86400 + 5), "20 d");
  assert.equal(formatAge(-50), "1 min", "clock skew (a future timestamp) is never a negative age");
});

test("wording is deterministic: same facts and same `now`, same text", () => {
  const g = gold({ totalKnownCopper: 10, charactersWithKnownGold: 1, oldestKnownGoldObservedAt: NOW - 100 });
  assert.deepEqual(describeGoldTotal(g, NOW), describeGoldTotal(g, NOW));
});
