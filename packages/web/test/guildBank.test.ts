// The Guild Bank card's wording. This is where the trust model meets the UI:
// UNKNOWN is never shown as empty or as numbers, LAST_SEEN is never shown as
// current, and an INACCESSIBLE tab is never shown as empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeGuildCapacity, describeGuildCaveats, describeGuildContents, describeGuildState, describeGuildTab } from "../src/guildBank.ts";
import type { GuildBankSection, GuildBankTab, SectionStatus } from "../src/types.ts";

const fmt = (t: number | undefined) => (t === undefined ? "an unknown time" : `T${t}`);

function guild(over: Partial<GuildBankSection> & { status: SectionStatus }): GuildBankSection {
  return { ownerScope: "GUILD", tabs: [], itemsKnownEmpty: false, items: [], ...over };
}
const observed = (over: Partial<SectionStatus> = {}): SectionStatus => ({ state: "OBSERVED", completeness: "complete", observedAt: 100, ...over });

// --- state -----------------------------------------------------------------------------------------------

test("UNKNOWN: 'Never observed', the addon's reason when given, and never 'currently observed'", () => {
  const d = describeGuildState({ state: "UNKNOWN", reason: "Guild Bank identity was not ready" }, fmt);
  assert.equal(d.headline, "Never observed");
  assert.equal(d.currentlyObserved, false);
  assert.match(d.detail!, /Guild Bank identity was not ready/);
  assert.equal(describeGuildState({ state: "UNKNOWN" }, fmt).detail, undefined);
});

test("LAST_SEEN: explicitly NOT current, with the time of the original observation and a warning it may have changed", () => {
  const d = describeGuildState({ state: "LAST_SEEN", completeness: "complete", observedAt: 4242 }, fmt);
  assert.equal(d.currentlyObserved, false);
  assert.match(d.headline, /not currently observed/);
  assert.doesNotMatch(d.headline, /^Observed/);
  assert.match(d.detail!, /T4242/);
  assert.match(d.detail!, /may have changed/);
});

test("OBSERVED complete: current, with the observation time and no partial warning", () => {
  const d = describeGuildState(observed({ observedAt: 777 }), fmt);
  assert.equal(d.currentlyObserved, true);
  assert.equal(d.headline, "Observed T777");
  assert.equal(d.detail, undefined);
});

test("OBSERVED but partial: says the listing covers only the confirmed tabs, and passes the addon's coverage note along", () => {
  const d = describeGuildState(observed({ completeness: "partial", coverageNote: "Guild Bank query response timed out" }), fmt);
  assert.equal(d.currentlyObserved, true);
  assert.match(d.detail!, /Partial capture/);
  assert.match(d.detail!, /only the confirmed tabs/);
  assert.match(d.detail!, /timed out/);
});

test("no state other than OBSERVED is ever 'currently observed'", () => {
  for (const status of [{ state: "UNKNOWN" }, { state: "LAST_SEEN", observedAt: 1 }] as SectionStatus[]) {
    assert.equal(describeGuildState(status, fmt).currentlyObserved, false, status.state);
  }
});

// --- tabs ------------------------------------------------------------------------------------------------

test("an INACCESSIBLE tab is shown as inaccessible with UNKNOWN contents - never as empty", () => {
  const d = describeGuildTab({ id: 3, name: "Officers", viewable: false, state: "INACCESSIBLE" });
  assert.equal(d.tone, "inaccessible");
  assert.equal(d.label, "Inaccessible");
  assert.match(d.detail!, /contents are unknown \(not empty\)/);
  assert.doesNotMatch(d.label, /empty/i);
});

test("an OBSERVED tab is observed; an UNKNOWN viewable tab is 'not confirmed' with the addon's note", () => {
  assert.deepEqual(describeGuildTab({ state: "OBSERVED" }), { label: "Observed", tone: "observed" });
  const d = describeGuildTab({ state: "UNKNOWN", viewable: true, note: "Guild Bank query response timed out" });
  assert.equal(d.label, "Not confirmed");
  assert.equal(d.tone, "unknown");
  assert.match(d.detail!, /timed out/);
  assert.match(d.detail!, /contents are unknown/);
});

test("an unfamiliar or missing tab state is 'unknown', quoted back, and never treated as observed or empty", () => {
  const future = describeGuildTab({ state: "SOME_FUTURE_STATE" });
  assert.equal(future.tone, "unknown");
  assert.match(future.detail!, /SOME_FUTURE_STATE/);
  const none = describeGuildTab({});
  assert.equal(none.tone, "unknown");
  assert.match(none.detail!, /No state reported/);
});

// --- capacity / contents / caveats ---------------------------------------------------------------------------------

test("UNKNOWN has no capacity, no contents claim, and no caveats - not zero slots, not empty", () => {
  const g = guild({ status: { state: "UNKNOWN" } });
  assert.equal(describeGuildCapacity(g), undefined);
  assert.equal(describeGuildContents(g), "Contents unknown.");
  assert.deepEqual(describeGuildCaveats(g), []);
});

test("capacity is for the SCANNED tabs only, and 'no tab scanned' is stated instead of a misleading 0/0", () => {
  assert.equal(describeGuildCapacity(guild({ status: observed(), freeSlots: 193, totalSlots: 196 })), "193 free / 196 slots in the scanned tabs");
  assert.match(describeGuildCapacity(guild({ status: observed(), freeSlots: 0, totalSlots: 0 }))!, /No tab was scanned/);
  assert.match(describeGuildCapacity(guild({ status: observed() }))!, /No tab was scanned/);
  assert.equal(describeGuildCapacity(guild({ status: observed(), freeSlots: undefined, totalSlots: 98 })), "? free / 98 slots in the scanned tabs");
});

test("LAST_SEEN capacity and contents are phrased as of the last observation, not as current", () => {
  const g = guild({ status: { state: "LAST_SEEN", completeness: "complete", observedAt: 5 }, freeSlots: 10, totalSlots: 98, items: [{ name: "A" }, { name: "B" }] });
  assert.match(describeGuildCapacity(g)!, /as of the last observation/);
  assert.match(describeGuildContents(g), /were recorded at the last observation/);
  assert.match(describeGuildContents({ ...g, items: [], itemsKnownEmpty: true }), /observed empty at the last observation/);
});

test("'empty' is claimed only when the addon marked the scanned tabs known-empty; otherwise it says nothing was observed", () => {
  const empty = guild({ status: observed(), itemsKnownEmpty: true });
  assert.equal(describeGuildContents(empty), "Every scanned tab was observed empty.");
  const noneObserved = guild({ status: observed(), itemsKnownEmpty: false, items: [] });
  assert.equal(describeGuildContents(noneObserved), "No item contents were observed.");
  assert.doesNotMatch(describeGuildContents(noneObserved), /empty/i);
});

test("items are described as aggregated, with the source tab not recorded", () => {
  const g = guild({ status: observed(), items: [{ name: "A" }] });
  assert.match(describeGuildContents(g), /1 distinct item observed/);
  assert.match(describeGuildContents(g), /source tab of an item is not recorded/);
});

test("caveats say inaccessible and unconfirmed tabs have UNKNOWN contents, with correct singular/plural", () => {
  const tabs: GuildBankTab[] = [{ state: "OBSERVED" }, { state: "INACCESSIBLE" }, { state: "INACCESSIBLE" }, { state: "UNKNOWN", note: "x" }];
  assert.deepEqual(describeGuildCaveats(guild({ status: observed(), tabs })), [
    "2 tabs are inaccessible to the observing character: their contents are unknown.",
    "1 tab was not confirmed: their contents are unknown.",
  ]);
  assert.deepEqual(describeGuildCaveats(guild({ status: observed(), tabs: [{ state: "INACCESSIBLE" }] })), [
    "1 tab is inaccessible to the observing character: their contents are unknown.",
  ]);
  assert.deepEqual(describeGuildCaveats(guild({ status: observed(), tabs: [{ state: "OBSERVED" }] })), []);
});
