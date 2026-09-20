// Focused checks on the system prompt's interpretation rules for the
// compact LlmContext (see llmContext.ts and the LLM-evaluation findings:
// a model fabricated an entire inventory transition for a single-snapshot
// character, and separately mis-converted copper to gold). These assert
// the presence/intent of each rule via loose content matches, not a
// brittle snapshot of the whole prompt - the exact wording is expected to
// keep evolving.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_MY_ACCOUNT_SYSTEM_PROMPT } from "../src/systemPrompt.ts";

test("explains comparisonStatus AVAILABLE vs INSUFFICIENT_HISTORY and forbids claiming 'no changes' when history is insufficient", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"comparisonStatus"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"AVAILABLE"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"INSUFFICIENT_HISTORY"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /not yet enough history to compare/i);
});

test("instructs the model to treat latestTransition as authoritative when AVAILABLE, and never fabricate one when insufficient history", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"latestTransition"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /use it directly/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never invent, guess, or fabricate/i);
});

test("instructs the model to keep each latestTransition atomic and scoped to its own character", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /atomic/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never combine values from one character's/i);
});

test("instructs the model never to invent a delta and to report (not silently reconcile) an inconsistency", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never state a delta/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /inconsistent/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /report that inconsistency/i);
});

test("explains xpCurrentLevel as current-level progress (not cumulative) and forbids describing XP as increasing/decreasing", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"xpCurrentLevel"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /current-level/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /not cumulative/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /increased or decreased/i);
});

test("instructs the model to use the supplied formatted gold strings rather than independently converting copper", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldDeltaFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /do not independently convert copper/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /10,000 copper = 1 gold/);
});

test("declares goldFormatted/goldDeltaFormatted/totalKnownFormatted authoritative and instructs copying them directly rather than recalculating", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldDeltaFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"totalKnownFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /authoritative, ready-to-use display values/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /copy the applicable supplied formatted value directly/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /rather than recalculating or reformatting/i);
});

test("clarifies that omitting one requested gold value must not cause unrelated gold values to be recalculated", () => {
  // Regression guard for the isolated Test B finding: "Do not calculate a
  // total" triggered the model to also recompute unrelated per-character
  // gold values instead of copying the supplied goldFormatted strings.
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /regardless of which other gold values the user asks you to include or omit/i);
});

test("instructs the model to use latestTransitionIndex as the complete qualifying set for 'which characters...' questions, and not to rediscover it by scanning", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"latestTransitionIndex"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldChanged"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"inventoryChanged"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /complete, authoritative qualifying set/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /do not independently rediscover the qualifying set/i);
});

test("documents that non-membership in a *Changed list does not mean 'observed unchanged'", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /non-membership does not necessarily mean "observed unchanged"/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never observed/i);
});

test("still contains the pre-existing OBSERVED/UNKNOWN and inferred-cause rules unmodified in intent", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /does not mean zero, empty, or absent/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /inferred cause/i);
});

test("no longer references structures the LlmContext projection does not send (snapshotHistory, recentChanges, largestRecentChanges)", () => {
  // Regression guard: these were real field names in the old prompt,
  // describing the full AccountContext the model used to receive. The
  // model now receives only the compact LlmContext (llmContext.ts), which
  // doesn't have these fields - stale references would be actively
  // misleading, not just unused.
  assert.doesNotMatch(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /snapshotHistory/);
  assert.doesNotMatch(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"recentChanges"/);
  assert.doesNotMatch(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"largestRecentChanges"/);
});

test("explains that Forever is a distinct client/version, realm-scoped, and never to be treated as (or merged with) Classic Era", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"forever"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /Forever/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /NOT Classic Era/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /Classic Era, TBC Anniversary, and Forever, characters and economic data .*scoped per realm/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never combine data across different versions/i);
});

test("documents the copper convention in-band: Copper-suffixed fields are raw copper integers, 1 gold = 100 silver = 10,000 copper", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /ends in "Copper"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /raw copper integer/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /1 gold = 100 silver = 10,000 copper/);
});

test("distinguishes a character's professions observation status from a profession's coverage status, and never reads UNKNOWN as none/zero", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"professionsObservationStatus"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /different concept from a profession coverage status/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /does NOT mean the character has no professions/i);
});

test("explains Forever's indeterminate 0/0 profession rows", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"indeterminate": true/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /NOT evidence the character has that profession/);
});

test("forbids inferring events or causes from state differences, and keeps the pre-existing grounding rules", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /must not be inferred into events or causes/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /authoritative source/i);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /do not invent facts/i);
});

// --- goldSummary scope (realm-partitioned versions have no version-wide total) ---

test("explains that goldSummary is scope-shaped: per-realm byRealm for realm versions, one total for Retail", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldSummary"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"goldSummary\.byRealm"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /deliberately NO version-wide total/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"account-wide"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /Classic Era, TBC Anniversary, and Forever its "scope" is "realm"/);
});

test("says a missing total means unobserved (never zero), and that the total covers only the counted characters", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /missing "totalKnownCopper" means no gold was observed there - never zero/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"charactersWithKnownGold"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"charactersWithUnknownGold"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /excluded, not counted as 0/);
});

test("says totals are last-observed values (staleness fields explained), not live balances", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"staleCharactersWithKnownGold"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"oldestKnownGoldObservedAt"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /not a live balance/);
});

test("without a named realm the model lists each realm; a combined figure only on request, labelled as arithmetic across separate economies", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /without naming a realm, list each realm's figure separately/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /explicitly asks for a combined figure across realms/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /arithmetic across separate economies that are not one balance/);
});

test("the formatted-total 'authoritative' rule is scoped: a realm's total is never presented as another realm's or the version's", () => {
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /"totalKnownFormatted"/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /authoritative, ready-to-use display values for the scope they belong to/);
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /Never present one realm's "totalKnownFormatted" as another realm's, or as the whole version's/);
  // The pre-existing "combine realms" prohibition is unchanged and no longer contradicted by the payload.
  assert.match(ASK_MY_ACCOUNT_SYSTEM_PROMPT, /never combine totals across two different realms/);
});
