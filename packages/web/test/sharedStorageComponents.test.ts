// The Shared Storage surface RENDERED (checkpoint C5): components are rendered to static markup with
// react-dom/server (the app's .tsx is compiled by test/tsxLoader.mjs) and the markup is asserted on. Every
// state the UI can be in is rendered from props: loading, empty, owners, restricted guilds, notices, load
// failures, the deletion dialog. Effects and clicks are not run here; their decisions live in the pure
// modules (sharedStorageView.test.ts), and the live behaviour was checked in a real browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api.ts";
import { InventoryCard } from "../src/components/CharacterDetail.tsx";
import { SharedDeleteDialogView } from "../src/components/DeleteSharedStorageModal.tsx";
import GuildBankCard from "../src/components/GuildBankCard.tsx";
import SharedOwnerCard from "../src/components/SharedOwnerCard.tsx";
import { IntegrityFailureNotice, SharedStorageBody, ownerAnchorId } from "../src/components/SharedStorageView.tsx";
import {
  CARRIED_GUILD_NOTE,
  CARRIED_GUILD_TITLE,
  CARRIED_WARBAND_NOTE,
  CARRIED_WARBAND_TITLE,
  EMPTY_HEADLINE,
  OPEN_SHARED_GUILD,
  OPEN_SHARED_WARBAND,
  REAPPEARANCE_WARNING,
  describeOwnerDeletion,
} from "../src/sharedStorage.ts";
import type { GuildBankSection, InventorySection } from "../src/types.ts";
import { BIG_ID, WARBAND_OWNER, fmt, guildIdentity, items, narrowGuildObservation, observation, ownerView, realWarband, response, source } from "./sharedStorageFixtures.ts";

const render = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const noop = () => {};

const body = (props: Partial<Parameters<typeof SharedStorageBody>[0]> & { status: "loading" | "ready" | "error" }) =>
  render(createElement(SharedStorageBody, { onRetry: noop, onRequestClear: noop, ...props }));
const card = (owner = realWarband(), anchorId = "shared-warband") => render(createElement(SharedOwnerCard, { owner, anchorId, onRequestClear: noop, formatTime: fmt }));

// --- loading and empty ------------------------------------------------------------------------------------------

test("loading: a stable placeholder that says what is loading, marked busy, with no owner and no empty-storage claim", () => {
  const html = body({ status: "loading" });
  assert.match(html, /aria-busy="true"/);
  assert.match(text(html), /Loading shared storage…/);
  assert.equal(count(html, /shared-owner/g), 0);
  assert.doesNotMatch(text(html), /No shared storage has been observed/);
});

test("a refresh keeps the existing owners visible (no jump to a placeholder)", () => {
  const html = body({ status: "loading", data: response(realWarband()) });
  assert.match(html, /aria-busy="true"/);
  assert.equal(count(html, /class="panel shared-owner"/g), 1);
  assert.doesNotMatch(text(html), /Loading shared storage/);
});

test("empty: 'no shared storage has been observed yet', no owner card, and no fake empty Guild Bank", () => {
  const html = body({ status: "ready", data: response(null) });
  const t = text(html);
  assert.ok(t.includes(EMPTY_HEADLINE));
  assert.match(t, /An unobserved bank is unknown, not empty/);
  assert.equal(count(html, /class="panel shared-owner"/g), 0);
  assert.equal(count(html, /id="shared-guild/g), 0);
  assert.equal(count(html, /id="shared-warband"/g), 0);
  assert.doesNotMatch(t, /0 items|Empty\./);
  assert.match(html, /<h2>Shared Storage<\/h2>/);
});

// --- the real Warband --------------------------------------------------------------------------------------------------

test("[REAL] the Warband is ONE owner card however many exports carried it, saying what it is and how far to trust it", () => {
  const html = body({ status: "ready", data: response(realWarband()) });
  const t = text(html);
  assert.equal(count(html, /class="panel shared-owner"/g), 1, "exactly one owner, although two exports carried it");
  assert.match(html, /<h3 id="shared-warband-title">Warband Bank/);
  assert.match(html, /class="tag tag-derived" title="Derived: the Dashboard reconciled every stored observation/);
  assert.match(t, /Account-level shared storage/);
  assert.match(t, /98 distinct items · \d+ total quantity/);
  assert.match(t, /98 of 98 slots occupied \(0 free\)/);
  assert.match(t, /Observed .* \(1h ago\)/);
  assert.match(html, /freshness-badge freshness-recent">Recent</);
  assert.match(t, /Complete observation/);
  assert.match(t, /Carried by exports made afterwards \(last seen\)/);
  assert.match(t, /Seen in 2 exports from Virek · Cairne/);
  assert.match(t, /One observation, carried by 2 exports\. The exports are not separate observations\./);
  assert.match(t, /The observation itself is real, observed evidence/);
  assert.equal(count(html, /class="shared-item-name"/g), 98, "98 items, none duplicated by the second export");
  assert.doesNotMatch(t, /Guild Bank carried|Contents unknown/);
  assert.equal(count(html, /id="shared-guild/g), 0, "no Guild owner and no empty Guild card");
});

test("the provenance table lists both exports as replays of one observation, with the visit", () => {
  const html = card();
  assert.match(html, /<caption class="sr-only">Carrying exports, newest first<\/caption>/);
  assert.equal(count(html, /Replayed \(last seen\)/g), 2);
  assert.match(text(html), /Elana, Silvermoon City/);
  assert.match(text(html), /Provenance names the characters whose exports carried this observation\. It does not say which character opened the bank/);
});

test("a large inventory renders inside a bounded, keyboard-scrollable region with a filter, a caption, and header cells with scope", () => {
  const big = ownerView(WARBAND_OWNER, { current: observation({ content: { ...observation().content, items: items(500), totalSlots: 500, freeSlots: 0 } }) });
  const started = Date.now();
  const html = card(big);
  assert.ok(Date.now() - started < 2000, "500 rows render quickly");
  assert.equal(count(html, /class="shared-item-name"/g), 500);
  assert.match(html, /<div class="shared-table-wrap" role="region" aria-label="Warband Bank: item list" tabindex="0">/);
  assert.match(html, /<caption class="sr-only">Warband Bank: items, aggregated across tabs<\/caption>/);
  assert.ok(count(html, /<th scope="col"/g) >= 4);
  assert.match(html, /<th scope="row" class="shared-item-name">Item 001<\/th>/);
  const inputId = /<input id="([^"]+)" class="item-search-input shared-filter"/.exec(html)![1];
  assert.match(html, new RegExp(`<label for="${inputId.replace(/[:]/g, "\\:")}" class="sr-only">Filter Warband Bank items by name</label>`), "the filter has an associated label");
  assert.match(text(html), /500 items/);
});

test("unknown item fields render as '?', never 0 or blank", () => {
  const html = card(ownerView(WARBAND_OWNER, { current: observation({ content: { ...observation().content, items: [{ name: "Mystery" }], totalSlots: undefined, freeSlots: undefined } }) }));
  assert.match(html, /<td class="num">\?<\/td><td class="col-bound">\?<\/td><td class="num col-vendor">\?<\/td>/);
});

// --- guilds --------------------------------------------------------------------------------------------------------------------

test("a guild card: name as the headline, the opaque GuildClubID in technical details, tabs with text status, tab coverage lines", () => {
  const owner = ownerView(guildIdentity(BIG_ID, "Restricted Guild"), { current: narrowGuildObservation() });
  const html = card(owner, "shared-guild-1");
  const t = text(html);
  assert.match(html, /<h3 id="shared-guild-1-title">Restricted Guild/);
  assert.equal(/<h3[^>]*>[^<]*18014398509481985/.test(html), false, "the id is not the headline");
  assert.match(html, /<dt>GuildClubID<\/dt><dd class="shared-mono">18014398509481985<\/dd>/, "the id is preserved exactly in the details");
  assert.match(t, /Guild Bank · guild-level shared storage/);
  assert.match(t, /Materials Observed/);
  assert.match(t, /Officers Inaccessible Not viewable by the observing character - its contents are unknown \(not empty\)\./);
  assert.match(t, /Raid Not confirmed Viewable but not confirmed \(Guild Bank query response timed out\) - its contents are unknown\./);
  assert.match(t, /Observed tabs: 1, 2/);
  assert.match(t, /Inaccessible to the observing character: 3 \(contents unknown, not empty\)/);
  assert.match(t, /Not confirmed: 4 \(contents unknown, not empty\)/);
  assert.match(t, /6 of 196 slots occupied in the scanned tabs \(190 free\)/);
  assert.match(t, /Items are listed together: an observation does not record which tab held each item\./);
  assert.match(t, /Seen live by at least one export/);
  assert.doesNotMatch(t, /\bEmpty\b/, "no tab or bank is called empty");
});

test("a guild with current:null and a known name says CONTENTS UNKNOWN, not empty, and shows no item table", () => {
  const locked = ownerView(guildIdentity("1.8014398509482e+16", "Locked Guild"), { current: null, observationCount: { total: 1, complete: 1, partial: 0, informationless: 1 } });
  const html = card(locked, "shared-guild-1");
  const t = text(html);
  assert.match(html, /<h3 id="shared-guild-1-title">Locked Guild/);
  assert.match(t, /Contents unknown/);
  assert.match(t, /That is not the same as empty/);
  assert.equal(count(html, /<table/g), 0);
  assert.doesNotMatch(t, /Observed empty|0 items|Empty\./);
  assert.match(t, /1 with no readable contents/);
  assert.match(html, /<dd class="shared-mono">1\.8014398509482e\+16<\/dd>/, "a scientific-notation-looking id stays opaque text");
});

test("several guilds: one card each with unique anchors in order, after the Warband", () => {
  const doc = response(realWarband(), [ownerView(guildIdentity("111", "First"), { current: narrowGuildObservation() }), ownerView(guildIdentity("222", "Second")), ownerView(guildIdentity(BIG_ID, "Third"))]);
  const html = body({ status: "ready", data: doc });
  assert.deepEqual([...html.matchAll(/<section class="panel shared-owner" id="([^"]+)"/g)].map((m) => m[1]), ["shared-warband", "shared-guild-1", "shared-guild-2", "shared-guild-3"]);
  assert.equal(count(html, /class="panel shared-owner"/g), 4);
  assert.equal(ownerAnchorId(guildIdentity("x"), 4), "shared-guild-5");
});

// --- notices ----------------------------------------------------------------------------------------------------------------------

test("a newer partial, an earlier broader observation and a conflict are shown as labelled notices with openable, separately labelled observations", () => {
  const owner = ownerView(guildIdentity("111", "G"), {
    current: narrowGuildObservation(),
    latestPartial: narrowGuildObservation({ completeness: "partial", effectiveObservedAt: 1_789_965_999 }),
    broaderCoverageEarlier: observation({ effectiveObservedAt: 1_789_960_000, coverage: { observedTabs: [1, 2, 3, 4], inaccessibleTabs: [], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [] } }),
    conflict: { effectiveObservedAt: 1_789_965_174, others: [observation({ contentHash: "b".repeat(64) })] },
  });
  const html = card(owner, "shared-guild-1");
  const t = text(html);
  assert.match(t, /Newer partial observation available/);
  assert.match(t, /remains the primary contents view; the partial one is never merged into it/);
  assert.match(t, /An earlier observation had broader tab visibility/);
  assert.match(t, /Its contents are not combined with the current ones/);
  assert.match(t, /Conflicting observations were recorded for the same time/);
  assert.match(t, /cannot tell which is correct/);
  assert.match(t, /View: Newer partial observation \(T1789965999\)/);
  assert.match(t, /View: Earlier observation with broader coverage \(T1789960000\)/);
  assert.match(t, /View: Conflicting observation 1/);
  assert.match(html, /class="shared-notice shared-notice-newer-partial" role="note"/);
  assert.equal(count(html, /class="shared-notice /g), 3);
  assert.match(t, /Partial observation/, "the partial one is labelled as partial inside its own view");
});

test("a healthy owner shows no notices", () => {
  assert.equal(count(card(), /class="shared-notice/g), 0);
});

test("provenance truncation is stated", () => {
  const cut = ownerView(WARBAND_OWNER, { current: observation({ provenance: { totalSources: 37, totalCharacters: 4, truncated: true, sources: Array.from({ length: 10 }, (_, i) => source({ exportObservedAt: 100 + i })) } }) });
  const html = card(cut);
  assert.match(text(html), /Showing the newest 10 of 37 exports\./);
  assert.match(text(html), /Seen in 37 exports from 4 characters/);
});

// --- accessibility ------------------------------------------------------------------------------------------------------------------

test("semantic structure: each card is a labelled section with a heading, status is conveyed in text (not colour alone), and buttons name their owner", () => {
  const html = card();
  assert.match(html, /<section class="panel shared-owner" id="shared-warband" aria-labelledby="shared-warband-title">/);
  assert.match(html, /<h3 id="shared-warband-title">/);
  assert.match(html, /<button class="danger-button" aria-label="Clear stored history for Warband Bank">Clear stored history…<\/button>/);
  assert.match(html, /status-observed">Complete observation</, "completeness is a text badge");
  assert.match(html, /freshness-recent">Recent</, "freshness is a text badge");
  const guildHtml = card(ownerView(guildIdentity("111", "Restricted Guild"), { current: narrowGuildObservation() }), "shared-guild-1");
  assert.match(guildHtml, /aria-label="Clear stored history for Restricted Guild"/);
  assert.match(guildHtml, /status-badge status-neutral">Inaccessible</, "an inaccessible tab is labelled in words");
});

// --- character page: what an export CARRIED --------------------------------------------------------------------------------------------

const warbandSection = (state: "LAST_SEEN" | "UNKNOWN"): InventorySection => ({
  status: { state },
  itemsKnownEmpty: false,
  items: [{ name: "Light Leather", qty: 3 }],
  freeSlots: 0,
  totalSlots: 98,
});

test("the character page's Warband card says it is what THIS EXPORT carried, drops the stale 'until reconciliation' wording, and links to the reconciled view", () => {
  const html = render(createElement(InventoryCard, { title: CARRIED_WARBAND_TITLE, inv: warbandSection("LAST_SEEN"), note: CARRIED_WARBAND_NOTE, actionLabel: OPEN_SHARED_WARBAND, onAction: noop }));
  const t = text(html);
  assert.match(t, /Warband Bank carried by this export/);
  assert.match(t, /historical evidence from this export, not this character's bank/);
  assert.match(t, /the reconciled Warband Bank is in Shared Storage/);
  assert.doesNotMatch(t, /until account-scope reconciliation is implemented|excluded from account totals until/);
  assert.match(html, /<button class="link-button">View the reconciled Warband Bank →<\/button>/);
  assert.equal(count(render(createElement(InventoryCard, { title: CARRIED_WARBAND_TITLE, inv: warbandSection("LAST_SEEN"), note: CARRIED_WARBAND_NOTE })), /link-button/g), 0, "no handler, no link");
});

test("the character page's Guild card is 'carried by this export' too, links to Shared Storage when it carried an observation, and has no link when it carried none", () => {
  const carried: GuildBankSection = { status: { state: "LAST_SEEN", completeness: "complete", observedAt: 100 }, ownerScope: "GUILD", guildClubId: BIG_ID, guildName: "Restricted Guild", tabs: [], itemsKnownEmpty: false, items: [], freeSlots: 98, totalSlots: 98 };
  const html = render(createElement(GuildBankCard, { guild: carried, onOpenSharedStorage: noop }));
  const t = text(html);
  assert.ok(t.includes(CARRIED_GUILD_TITLE));
  assert.ok(t.includes(CARRIED_GUILD_NOTE));
  assert.doesNotMatch(t, /until guild-scope reconciliation is implemented|transitional/i);
  assert.ok(t.includes(OPEN_SHARED_GUILD));
  assert.match(html, /<button class="link-button">View the reconciled Guild Bank →<\/button>/);

  const unknown: GuildBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "GUILD", tabs: [], itemsKnownEmpty: false, items: [] };
  const none = render(createElement(GuildBankCard, { guild: unknown, onOpenSharedStorage: noop }));
  assert.equal(count(none, /link-button/g), 0, "an export that carried no observation has nothing to link to");
  assert.match(text(none), /Never observed/);
});

// --- deletion dialog -------------------------------------------------------------------------------------------------------------------------

const dialog = (owner = WARBAND_OWNER as Parameters<typeof describeOwnerDeletion>[0], over: Partial<Parameters<typeof SharedDeleteDialogView>[0]> = {}) =>
  render(
    createElement(SharedDeleteDialogView, {
      target: describeOwnerDeletion(owner),
      typed: "",
      onTyped: noop,
      busy: false,
      error: null,
      alreadyGone: null,
      onCancel: noop,
      onConfirm: noop,
      onAcknowledge: noop,
      ...over,
    }),
  );

test("the Warband confirmation: a labelled modal dialog naming the Warband / local account scope, carrying the exact reappearance sentence, destructive button disabled until 'Warband' is typed", () => {
  const html = dialog();
  const t = text(html);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="shared-delete-title" aria-describedby="shared-delete-warning"/);
  assert.match(html, /<h2 id="shared-delete-title">Clear stored Warband history\?<\/h2>/);
  assert.match(t, /Storage: Warband Bank/);
  assert.match(t, /Scope: This Dashboard's local Retail account scope/);
  assert.ok(t.includes(REAPPEARANCE_WARNING), "the exact required sentence");
  assert.match(html, /<p class="shared-warning" id="shared-delete-warning">Clears stored shared-storage history\. A later WoWSync export may add it again\.<\/p>/);
  assert.match(t, /Your characters and their imported snapshots are not touched/);
  assert.match(t, /To confirm, type Warband below:/);
  assert.match(html, /<button class="danger-button" disabled="">Clear stored history<\/button>/);
  assert.doesNotMatch(t, /permanent|forever|prevent future/i);
  assert.ok(html.includes('<button class="secondary-button" autofocus="">Cancel</button>'), "Cancel is the safe default (it takes the initial focus)");
  assert.match(html, /<label class="delete-confirm-label" for="shared-delete-input">/);
  assert.match(html, /<input id="shared-delete-input"/);
});

test("the Guild confirmation: the guild name for context, the exact GuildClubID as identity, and the ID (not the name) must be typed", () => {
  const owner = guildIdentity(BIG_ID, "Restricted Guild");
  const t = text(dialog(owner));
  assert.match(t, /Clear stored guild history\?/);
  assert.match(t, /Guild: Restricted Guild/);
  assert.match(t, /GuildClubID: 18014398509481985/);
  assert.match(t, /To confirm, type 18014398509481985 below:/);
  assert.match(t, /identified by its GuildClubID, not by its name/);
  assert.ok(t.includes(REAPPEARANCE_WARNING));
  assert.match(text(dialog(guildIdentity("222"))), /Guild: Name not recorded/);
});

test("the destructive button enables only when the exact text is typed; busy locks everything; errors are alerts; already-cleared is acknowledged, not treated as a deletion", () => {
  assert.doesNotMatch(dialog(WARBAND_OWNER, { typed: "Warband" }), /<button class="danger-button" disabled="">/);
  assert.match(dialog(WARBAND_OWNER, { typed: "warband" }), /<button class="danger-button" disabled="">/);
  assert.match(dialog(guildIdentity(BIG_ID, "G"), { typed: "18014398509481984" }), /<button class="danger-button" disabled="">/, "a JS-number sibling of the id does not enable it");
  assert.doesNotMatch(dialog(guildIdentity(BIG_ID, "G"), { typed: BIG_ID }), /<button class="danger-button" disabled="">/);

  const busy = dialog(WARBAND_OWNER, { typed: "Warband", busy: true });
  assert.match(busy, /Clearing…/);
  assert.match(busy, /<button class="secondary-button" disabled=""/);
  assert.match(busy, /<button class="icon-button" disabled="" aria-label="Close">/);

  const failed = dialog(WARBAND_OWNER, { typed: "Warband", error: "Not cleared: boom" });
  assert.match(failed, /<div class="import-error" role="alert">Not cleared: boom<\/div>/);

  const gone = dialog(WARBAND_OWNER, { alreadyGone: "This storage's history was already cleared - this action removed nothing." });
  assert.match(text(gone), /Already cleared/);
  assert.match(text(gone), /removed nothing/);
  assert.doesNotMatch(text(gone), /type Warband/);
});

// --- load failures ---------------------------------------------------------------------------------------------------------------------------

function integrityError(damaged: Array<Record<string, unknown>>) {
  return new ApiError("The shared-storage state cannot be shown.", "http", 500, "SHARED_STORAGE_INTEGRITY", { error: "x", code: "SHARED_STORAGE_INTEGRITY", damagedOwners: damaged });
}

test("an integrity failure is a distinct, non-generic screen: it names the damaged owners, offers a recovery per identifiable owner, hides all shared data, and exposes no SQL or stack", () => {
  const error = integrityError([{ ownerKey: `retail::guild::${BIG_ID}`, kind: "guild", guildClubId: BIG_ID }, { ownerKey: "retail::warband::local", kind: "warband" }, { ownerKey: "odd::key" }]);
  const html = body({ status: "error", error, data: response(realWarband()) });
  const t = text(html);
  assert.match(html, /<div class="error-notice shared-integrity" role="alert">/);
  assert.match(t, /Stored shared-storage data failed integrity validation/);
  assert.match(t, /Nothing was skipped or guessed/);
  assert.match(t, /Warband Bank Damaged/);
  assert.match(t, new RegExp(`Guild ${BIG_ID} Damaged`));
  assert.match(html, /aria-label="Clear stored history for Warband Bank"/);
  assert.match(html, new RegExp(`aria-label="Clear stored history for Guild ${BIG_ID}"`));
  assert.match(t, /Unrecognized owner \(odd::key\)/);
  assert.match(t, /could not be identified, so it cannot be cleared from here/);
  assert.equal(count(html, /Clear stored history…/g), 2, "no action for the unidentifiable owner");
  assert.ok(t.includes(REAPPEARANCE_WARNING));
  assert.equal(count(html, /class="panel shared-owner"/g), 0, "the possibly-stale data is not shown next to a damaged journal");
  assert.doesNotMatch(t, /SELECT|content_json|owner_json|stack|Retry/);
  assert.doesNotMatch(t, /Something went wrong/);
});

test("damaged Warband and damaged Guild each get their own recovery action", () => {
  const w = render(createElement(IntegrityFailureNotice, { error: integrityError([{ ownerKey: "retail::warband::local", kind: "warband" }]), onRequestClear: noop }));
  assert.match(w, /aria-label="Clear stored history for Warband Bank"/);
  const g = render(createElement(IntegrityFailureNotice, { error: integrityError([{ ownerKey: "retail::guild::111", kind: "guild", guildClubId: "111" }]), onRequestClear: noop }));
  assert.match(g, /aria-label="Clear stored history for Guild 111"/);
  assert.equal(render(createElement(IntegrityFailureNotice, { error: new ApiError("boom", "http", 500), onRequestClear: noop })), "", "it renders nothing for any other failure");
});

test("a generic API failure is shown as an error with Retry, never as an integrity problem or as empty storage", () => {
  const html = body({ status: "error", error: new ApiError("Can't reach the WoWSync server. Is it running?", "network") });
  const t = text(html);
  assert.match(html, /<div class="error-notice" role="alert">/);
  assert.match(t, /Can't reach the WoWSync server/);
  assert.match(html, />Retry</);
  assert.doesNotMatch(t, /integrity/i);
  assert.doesNotMatch(t, /No shared storage has been observed/);
});

test("the last action's result is announced as a status message", () => {
  const html = body({ status: "ready", data: response(null), flash: "Cleared stored history for Restricted Guild (3 observations, 3 carrying exports). A later WoWSync export may add it again." });
  assert.match(html, /<div class="shared-flash" role="status">Cleared stored history for Restricted Guild/);
});

// --- responsive rules and boundaries -----------------------------------------------------------------------------------------------------------

test("the stylesheet bounds the item table and hides secondary columns and wraps the chrome on small screens", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.shared-table-wrap\s*\{[^}]*max-height:\s*26rem;[^}]*overflow:\s*auto;/);
  const small = css.slice(css.lastIndexOf("@media (max-width: 600px)"));
  assert.match(small, /\.col-vendor, \.col-bound \{ display: none; \}/);
  assert.match(small, /\.shared-facts \{ grid-template-columns: 1fr;/);
  assert.match(small, /\.version-tabs, \.view-tabs \{ flex-wrap: wrap; \}/);
  assert.match(css, /\.sr-only\s*\{[^}]*clip:/);
});

test("shared storage stays out of AccountFacts, totals, search, recent changes, AccountContext and the AI context UI: none of those modules or screens reads it (this checkpoint is presentation only)", () => {
  const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
  for (const file of ["totals.ts", "scopedFacts.ts", "components/AccountOverview.tsx", "components/AccountEconomy.tsx", "components/CharactersGrid.tsx", "components/AskAccountModal.tsx", "components/DeveloperExportModal.tsx", "components/ImportModal.tsx", "importOutcome.ts"]) {
    assert.doesNotMatch(src(file), /sharedStorage|SharedStorage|shared-storage/, `${file} must not read shared storage`);
  }
  // The only consumers are the Shared Storage surface itself, the App shell that hosts it, and the character-page wording.
  const users = ["App.tsx", "components/CharacterDetail.tsx", "components/GuildBankCard.tsx"].filter((f) => /shared-?storage/i.test(src(f)));
  assert.deepEqual(users.sort(), ["App.tsx", "components/CharacterDetail.tsx", "components/GuildBankCard.tsx"].sort());
});
