// The wording and decisions of the Shared Storage surface (checkpoint C5), tested as pure functions:
// what is said about time, freshness, carriage, completeness, capacity, contents, coverage, provenance,
// notices, deletion and load failures. Component rendering is in sharedStorageComponents.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import {
  REAPPEARANCE_WARNING,
  contentsState,
  coverageSummary,
  describeCapacity,
  describeCarriage,
  describeCompleteness,
  describeContents,
  describeCoverage,
  describeDeletionResult,
  describeIntegrityFailure,
  describeOwnerDeletion,
  describeProvenance,
  describeTiming,
  filterItemRows,
  isEmptyShared,
  isOwnerDeletionConfirmed,
  itemCountLabel,
  itemRows,
  itemSummary,
  orderedOwners,
  ownerHeading,
  ownerNotices,
  performOwnerDelete,
  tabRows,
} from "../src/sharedStorage.ts";
import { BIG_ID, WARBAND_OWNER, fmt, guildIdentity, items, narrowGuildObservation, observation, ownerView, realWarband, response, source, T } from "./sharedStorageFixtures.ts";

// --- ownership and identity ----------------------------------------------------------------------------------

test("the Warband is presented as account-level shared storage that is not a Battle.net account; a guild leads with its name, and its id is technical detail", () => {
  const w = ownerHeading(WARBAND_OWNER);
  assert.equal(w.title, "Warband Bank");
  assert.match(w.kindLabel, /Account-level/);
  assert.ok(w.technical.some((r) => /not a Battle\.net account id/.test(r.value)));

  const g = ownerHeading(guildIdentity(BIG_ID, "Restricted Guild"));
  assert.equal(g.title, "Restricted Guild");
  assert.deepEqual(g.technical.find((r) => r.label === "GuildClubID"), { label: "GuildClubID", value: BIG_ID });
  assert.equal(g.title.includes(BIG_ID), false, "the opaque id is not the headline");

  const unnamed = ownerHeading(guildIdentity("222"));
  assert.equal(unnamed.title, "Guild Bank");
  assert.match(unnamed.kindLabel, /name not recorded/);
});

test("owners are listed Warband first, then guilds; an empty document has none", () => {
  const doc = response(realWarband(), [ownerView(guildIdentity("111", "A")), ownerView(guildIdentity("222", "B"))]);
  assert.deepEqual(orderedOwners(doc).map((o) => o.owner.ownerKey), ["retail::warband::local", "retail::guild::111", "retail::guild::222"]);
  assert.equal(isEmptyShared(response(null)), true);
  assert.equal(isEmptyShared(doc), false);
  assert.equal(isEmptyShared(response(null, [ownerView(guildIdentity("1"))])), false);
});

// --- time, freshness and carriage: coherent, not contradictory --------------------------------------------------------

test("[REAL] 'recent' + 'last seen' + not live at export read coherently: freshness is the age of the observation, last seen is how the exports carried it", () => {
  const v = realWarband().current!;
  const t = describeTiming(v, fmt);
  assert.equal(t.observed, `Observed T${T}`);
  assert.equal(t.freshness, "recent");
  assert.equal(t.freshnessLabel, "Recent");
  assert.match(t.freshnessNote, /at most 3 days old/);
  assert.match(t.freshnessNote, /age of the observation itself, whatever way it reached the Dashboard/);
  assert.equal(t.clampNote, undefined);

  const c = describeCarriage(v);
  assert.match(c.headline, /last seen/);
  assert.match(c.detail, /every carrying export was made after the storage was closed/i);
  assert.match(c.detail, /real when it was made/);
  assert.doesNotMatch(`${t.freshnessNote} ${c.detail}`, /live now|currently open|up to date/i);
});

test("a stale observation says it may have changed; a live carrier says at least one export saw it open", () => {
  const stale = describeTiming(observation({ freshness: "stale", ageSeconds: 9 * 86400 }), fmt);
  assert.equal(stale.freshnessLabel, "Stale");
  assert.match(stale.freshnessNote, /more than 3 days old/);
  assert.match(stale.freshnessNote, /may have changed/);
  assert.equal(describeTiming(observation({ freshness: "unknown" }), fmt).freshnessLabel, "Unknown");

  const live = describeCarriage(observation({ liveAtExport: true, carrierStates: ["LAST_SEEN", "OBSERVED"] }));
  assert.match(live.headline, /live by at least one export/);
});

test("a claimed time later than its carrying export is explained, not silently used", () => {
  const t = describeTiming(observation({ claimedAfterCarrier: true, claimedObservedAt: T + 999, effectiveObservedAt: T }), fmt);
  assert.match(t.clampNote!, new RegExp(`T${T + 999}`));
  assert.match(t.clampNote!, /export's time is used/);
});

test("completeness: a partial observation says it lists only the confirmed tabs; a complete guild one still calls inaccessible tabs unknown", () => {
  assert.equal(describeCompleteness(observation({ completeness: "partial" }), "guild").partial, true);
  assert.match(describeCompleteness(observation({ completeness: "partial" }), "guild").detail, /only the tabs that were/);
  const complete = describeCompleteness(observation(), "guild");
  assert.equal(complete.partial, false);
  assert.match(complete.detail, /inaccessible: their contents are unknown/);
  assert.match(describeCompleteness(observation(), "warband").detail, /Every purchased tab/);
});

// --- capacity and contents -----------------------------------------------------------------------------------------

test("[REAL] capacity: 98 of 98 slots occupied (0 free); a guild's figure covers only the scanned tabs; unknown parts stay unknown", () => {
  assert.equal(describeCapacity(realWarband().current!, "warband"), "98 of 98 slots occupied (0 free)");
  assert.equal(describeCapacity(narrowGuildObservation(), "guild"), "6 of 196 slots occupied in the scanned tabs (190 free)");
  assert.equal(describeCapacity(observation({ content: { ...observation().content, freeSlots: undefined } }), "warband"), "98 slots (free slots unknown)");
  assert.equal(describeCapacity(observation({ content: { ...observation().content, totalSlots: undefined, freeSlots: undefined } }), "warband"), undefined);
  assert.match(describeCapacity(observation({ content: { ...observation().content, totalSlots: 0, freeSlots: 0 } }), "guild")!, /No tab was scanned, so no capacity is known/);
});

test("contents: unknown is never empty; 'empty' only when scanned tabs were found empty; no informative observation is unknown", () => {
  assert.equal(contentsState(null), "unknown");
  assert.equal(describeContents(null), "Contents unknown");
  assert.equal(contentsState(observation({ informative: false })), "unknown");
  const emptyUnknown = observation({ content: { ...observation().content, items: [], itemsKnownEmpty: false } });
  assert.equal(contentsState(emptyUnknown), "unknown", "no items and not known-empty is UNKNOWN");
  assert.doesNotMatch(describeContents(emptyUnknown), /empty/i);
  const empty = observation({ content: { ...observation().content, items: [], itemsKnownEmpty: true } });
  assert.equal(contentsState(empty), "empty");
  assert.match(describeContents(empty), /Observed empty/);
  assert.equal(contentsState(observation()), "items");
});

test("[REAL] 98 items: distinct count and total quantity; an unknown quantity means the total is not claimed", () => {
  assert.match(itemSummary(realWarband().current!), /^98 distinct items · \d+ total quantity$/);
  assert.equal(itemSummary(observation({ content: { ...observation().content, items: [{ name: "A", qty: 2 }, { name: "B" }] } })), "2 distinct items (some quantities unknown)");
  assert.equal(itemSummary(observation({ content: { ...observation().content, items: [{ name: "A", qty: 1 }] } })), "1 distinct item · 1 total quantity");
  assert.deepEqual([itemCountLabel(1, 1, false), itemCountLabel(98, 98, false), itemCountLabel(3, 98, true), itemCountLabel(1, 1, true)], ["1 item", "98 items", "3 of 98 items", "1 of 1 item"]);
});

test("item rows are sorted by name, never merged, keep unknown fields undefined, and unnamed items fall back to their reference last", () => {
  const rows = itemRows(
    observation({ content: { ...observation().content, items: [{ itemRef: "item:9", qty: 1 }, { name: "Zeta", qty: 2, bound: "yes" }, { name: "Alpha" }, { name: "Alpha", qty: 5 }] } }),
  );
  assert.deepEqual(rows.map((r) => r.name), ["Alpha", "Alpha", "Zeta", "item:9"]);
  assert.equal(rows.length, 4, "identical names are separate rows, never merged");
  assert.equal(rows.find((r) => r.name === "Alpha" && r.qty === undefined)!.vendorEachCopper, undefined);
  assert.equal(filterItemRows(rows, "  ZET ").length, 1);
  assert.equal(filterItemRows(rows, "").length, 4);
  assert.equal(filterItemRows(rows, "nothing").length, 0);
});

// --- guild tabs and coverage ----------------------------------------------------------------------------------------

test("an inaccessible tab is 'contents unknown (not empty)'; an unconfirmed tab is 'not confirmed'; neither is ever called empty", () => {
  const rows = tabRows(narrowGuildObservation());
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.description]));
  assert.equal(byName.Materials.label, "Observed");
  assert.equal(byName.Officers.label, "Inaccessible");
  assert.match(byName.Officers.detail!, /contents are unknown \(not empty\)/);
  assert.equal(byName.Raid.label, "Not confirmed");
  assert.match(byName.Raid.detail!, /timed out/);
  assert.match(byName.Raid.detail!, /contents are unknown/);
  for (const r of rows) assert.doesNotMatch(r.description.label, /empty/i);
});

test("coverage lines list observed, inaccessible and unconfirmed tabs, each unknown one flagged; a Warband has no per-tab coverage", () => {
  const lines = describeCoverage(narrowGuildObservation(), "guild");
  assert.deepEqual(lines, [
    "Observed tabs: 1, 2",
    "Inaccessible to the observing character: 3 (contents unknown, not empty)",
    "Not confirmed: 4 (contents unknown, not empty)",
  ]);
  assert.deepEqual(describeCoverage(realWarband().current!, "warband"), []);
  assert.equal(coverageSummary(narrowGuildObservation()), "2 tabs observed · 1 inaccessible · 1 not confirmed");
  assert.equal(describeCoverage(observation({ coverage: { observedTabs: [], inaccessibleTabs: [], unconfirmedTabs: [], unidentifiedTabs: 2, observedContainerIds: [] } }), "guild").at(-1), "2 tabs could not be identified.");
});

// --- provenance -------------------------------------------------------------------------------------------------------

test("[REAL] two exports of one observation: ONE observation, TWO exports, both from Virek", () => {
  const p = describeProvenance(realWarband().current!.provenance, fmt);
  assert.equal(p.headline, "Seen in 2 exports from Virek · Cairne");
  assert.match(p.oneObservation, /One observation, carried by 2 exports\. The exports are not separate observations\./);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.carrier), ["Replayed (last seen)", "Replayed (last seen)"]);
  assert.equal(p.rows[0].visit, "Elana, Silvermoon City");
  assert.equal(p.truncation, undefined);
  assert.match(p.note, /does not say which character opened the bank/);
});

test("provenance wording: one export, several characters, and a truncated list", () => {
  assert.equal(describeProvenance({ totalSources: 1, totalCharacters: 1, truncated: false, sources: [source()] }, fmt).headline, "Seen in 1 export from Virek · Cairne");
  assert.equal(describeProvenance({ totalSources: 1, totalCharacters: 1, truncated: false, sources: [source()] }, fmt).oneObservation, "One observation, carried by 1 export.");
  const many = describeProvenance({ totalSources: 5, totalCharacters: 3, truncated: false, sources: [source({ characterName: "Bravo", characterRealm: "Thrall" }), source()] }, fmt);
  assert.equal(many.headline, "Seen in 5 exports from 3 characters, most recently Bravo · Thrall");
  const cut = describeProvenance({ totalSources: 37, totalCharacters: 4, truncated: true, sources: Array.from({ length: 10 }, () => source()) }, fmt);
  assert.equal(cut.truncation, "Showing the newest 10 of 37 exports.");
  assert.equal(cut.rows.length, 10);
  assert.equal(describeProvenance({ totalSources: 1, totalCharacters: 1, truncated: false, sources: [source({ visitedNpc: undefined, visitedZone: undefined })] }, fmt).rows[0].visit, undefined);
});

// --- notices ------------------------------------------------------------------------------------------------------------------

test("a newer partial is surfaced with its time and coverage and never merged; an earlier broader observation is surfaced as earlier; a conflict is surfaced without picking a winner", () => {
  const partial = narrowGuildObservation({ completeness: "partial", effectiveObservedAt: T + 500 });
  const broader = observation({ effectiveObservedAt: T - 1000, coverage: { observedTabs: [1, 2, 3, 4], inaccessibleTabs: [], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [] } });
  const other = observation({ contentHash: "b".repeat(64) });
  const owner = ownerView(guildIdentity("111", "G"), {
    current: narrowGuildObservation(),
    latestPartial: partial,
    broaderCoverageEarlier: broader,
    conflict: { effectiveObservedAt: T, others: [other] },
  });
  const notices = ownerNotices(owner, fmt);
  assert.deepEqual(notices.map((n) => n.kind), ["newer-partial", "broader-earlier", "conflict"]);

  const [p, b, c] = notices;
  assert.equal(p.title, "Newer partial observation available");
  assert.match(p.text, new RegExp(`T${T + 500}`));
  assert.match(p.text, /remains the primary contents view/);
  assert.match(p.text, /never merged/);
  assert.equal(p.observations[0].label, "Newer partial observation");

  assert.equal(b.title, "An earlier observation had broader tab visibility");
  assert.match(b.text, /4 tabs observed/);
  assert.match(b.text, /not combined with the current ones/);
  assert.equal(b.observations[0].label, "Earlier observation with broader coverage");

  assert.equal(c.title, "Conflicting observations were recorded for the same time");
  assert.match(c.text, /2 observations with different contents/);
  assert.match(c.text, /cannot tell which is correct/);
  assert.equal(c.observations.length, 1);
  for (const n of notices) assert.doesNotMatch(n.text, /correct answer is|the right one/i);
});

test("current:null (only informationless observations) is 'contents unknown', never empty; a healthy owner has no notices", () => {
  const locked = ownerView(guildIdentity("1.8014398509482e+16", "Locked Guild"), { current: null, observationCount: { total: 1, complete: 1, partial: 0, informationless: 1 } });
  const n = ownerNotices(locked, fmt);
  assert.deepEqual(n.map((x) => x.kind), ["contents-unknown"]);
  assert.match(n[0].text, /not the same as empty/);
  assert.equal(ownerNotices(realWarband(), fmt).length, 0);
});

// --- deletion ------------------------------------------------------------------------------------------------------------------

test("the reappearance warning is the exact required sentence and never says permanent or forever", () => {
  assert.equal(REAPPEARANCE_WARNING, "Clears stored shared-storage history. A later WoWSync export may add it again.");
  for (const owner of [WARBAND_OWNER, guildIdentity(BIG_ID, "G")]) {
    const t = describeOwnerDeletion(owner);
    assert.equal(t.warning, REAPPEARANCE_WARNING);
    assert.doesNotMatch(JSON.stringify(t), /permanent|forever|prevent/i);
  }
});

test("Warband confirmation: identifies the Warband / local account scope and needs 'Warband' typed; Guild confirmation: names the guild, shows the exact GuildClubID, and needs the ID typed (never the name)", () => {
  const w = describeOwnerDeletion(WARBAND_OWNER);
  assert.equal(w.requiredText, "Warband");
  assert.deepEqual(w.summary, [{ label: "Storage", value: "Warband Bank" }, { label: "Scope", value: "This Dashboard's local Retail account scope" }]);
  assert.equal(isOwnerDeletionConfirmed("Warband", w), true);
  assert.equal(isOwnerDeletionConfirmed("  Warband  ", w), true);
  assert.equal(isOwnerDeletionConfirmed("warband", w), false);
  assert.equal(isOwnerDeletionConfirmed("", w), false);

  const g = describeOwnerDeletion(guildIdentity(BIG_ID, "Restricted Guild"));
  assert.equal(g.requiredText, BIG_ID);
  assert.deepEqual(g.summary, [{ label: "Guild", value: "Restricted Guild" }, { label: "GuildClubID", value: BIG_ID }]);
  assert.equal(isOwnerDeletionConfirmed(BIG_ID, g), true);
  assert.equal(isOwnerDeletionConfirmed("Restricted Guild", g), false, "the display name never confirms");
  assert.equal(isOwnerDeletionConfirmed("18014398509481984", g), false, "a sibling id that is the same JS number does not confirm");
  assert.equal(isOwnerDeletionConfirmed("1.8014398509482e+16", g), false);
  assert.ok(g.consequences.some((c) => /identified by its GuildClubID, not by its name/.test(c)));
  assert.ok(g.consequences.some((c) => /characters and their imported snapshots are not touched/.test(c)));
  assert.equal(describeOwnerDeletion(guildIdentity("222")).summary[0].value, "Name not recorded");
});

test("a delete request touches only the shared-storage owner: exactly one call, with that owner, and success needs the server to name it", async () => {
  const calls: unknown[] = [];
  const outcome = await performOwnerDelete(WARBAND_OWNER, async (owner) => {
    calls.push(owner);
    return { deleted: { owner: { ownerKey: owner.ownerKey }, observationsDeleted: 1, sourcesDeleted: 2 } };
  });
  assert.deepEqual(calls, [WARBAND_OWNER]);
  assert.deepEqual(outcome, { kind: "deleted", observationsDeleted: 1, sourcesDeleted: 2 });

  const mismatch = await performOwnerDelete(WARBAND_OWNER, async () => ({ deleted: { owner: { ownerKey: "retail::guild::x" } } }));
  assert.equal(mismatch.kind, "failed");
  assert.equal((await performOwnerDelete(WARBAND_OWNER, async () => ({}))).kind, "failed");
});

test("outcomes: only the server's own SHARED_OWNER_NOT_FOUND is 'already gone'; every other failure is a failure, and a lost reply says it may or may not have happened", async () => {
  const fail = (err: unknown) => performOwnerDelete(WARBAND_OWNER, async () => { throw err; });
  const gone = await fail(new ApiError("No stored history", "http", 404, "SHARED_OWNER_NOT_FOUND"));
  assert.equal(gone.kind, "already-gone");
  assert.match((gone as { message: string }).message, /nothing|removed nothing/);

  const otherNotFound = await fail(new ApiError("Not found", "http", 404, "NOT_FOUND"));
  assert.equal(otherNotFound.kind, "failed");
  assert.match((otherNotFound as { message: string }).message, /^Not cleared/);
  assert.equal((await fail(new ApiError("bad", "http", 400, "CONFIRMATION_MISMATCH"))).kind, "failed");
  assert.equal((await fail(new ApiError("boom", "http", 500))).kind, "failed");

  const lost = await fail(new ApiError("Can't reach the WoWSync server.", "network"));
  assert.equal(lost.kind, "failed");
  assert.match((lost as { message: string }).message, /may or may not have been/);
  assert.equal((await fail(new Error("weird"))).kind, "failed");
});

test("the status line after a delete names what was cleared and repeats that it may come back; already-cleared says nothing was removed", () => {
  assert.equal(
    describeDeletionResult(guildIdentity(BIG_ID, "Restricted Guild"), { kind: "deleted", observationsDeleted: 3, sourcesDeleted: 1 }),
    "Cleared stored history for Restricted Guild (3 observations, 1 carrying export). A later WoWSync export may add it again.",
  );
  assert.match(describeDeletionResult(WARBAND_OWNER, { kind: "deleted", observationsDeleted: 1, sourcesDeleted: 2 }), /the Warband Bank \(1 observation, 2 carrying exports\)/);
  assert.match(describeDeletionResult(guildIdentity("222"), { kind: "already-gone", message: "" }), /guild 222 was already cleared; nothing was removed/);
});

// --- integrity ---------------------------------------------------------------------------------------------------------------------

function integrityError(damaged: Array<Record<string, unknown>>) {
  return new ApiError("The shared-storage state cannot be shown.", "http", 500, "SHARED_STORAGE_INTEGRITY", {
    error: "x",
    code: "SHARED_STORAGE_INTEGRITY",
    damagedOwners: damaged,
  });
}

test("an integrity failure is described with its damaged owners and a recovery for each identifiable one; other failures are not integrity failures", () => {
  const f = describeIntegrityFailure(
    integrityError([
      { ownerKey: "retail::guild::111", kind: "guild", guildClubId: "111" },
      { ownerKey: "retail::warband::local", kind: "warband" },
      { ownerKey: "mystery::key" },
    ]),
  )!;
  assert.equal(f.heading, "Stored shared-storage data failed integrity validation");
  assert.match(f.explanation, /Nothing was skipped or guessed/);
  assert.deepEqual(f.damaged.map((d) => d.label), ["Warband Bank", "Guild 111", "Unrecognized owner (mystery::key)"], "the Warband first");
  assert.deepEqual(f.damaged[0].owner, WARBAND_OWNER);
  assert.deepEqual(f.damaged[1].owner, { kind: "guild", ownerKey: "retail::guild::111", guildClubId: "111" });
  assert.equal(f.damaged[2].owner, undefined, "an unrecognized owner has no recovery action");
  assert.ok(f.recovery.includes(REAPPEARANCE_WARNING));
  assert.doesNotMatch(JSON.stringify(f), /SELECT|content_json|stack/);

  assert.equal(describeIntegrityFailure(new ApiError("boom", "http", 500)), undefined);
  assert.equal(describeIntegrityFailure(new Error("x")), undefined);
  assert.equal(describeIntegrityFailure(new ApiError("x", "http", 500, "SHARED_STORAGE_INTEGRITY")), undefined, "a matching code without the details is not enough");
});

test("a large opaque GuildClubID survives every step from the API document to the recovery target unchanged", () => {
  const f = describeIntegrityFailure(integrityError([{ ownerKey: `retail::guild::${BIG_ID}`, kind: "guild", guildClubId: BIG_ID }]))!;
  const owner = f.damaged[0].owner!;
  assert.equal(owner.kind === "guild" && owner.guildClubId, BIG_ID);
  assert.equal(describeOwnerDeletion(owner).requiredText, BIG_ID);
  assert.equal(items(3).length, 3);
});
