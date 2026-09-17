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
