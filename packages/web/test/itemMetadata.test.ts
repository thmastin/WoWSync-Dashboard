// Item metadata presentation: one lookup serves every item list, wording comes from the server's resolved views (the
// web app derives no label), unknown stays "?", and a list rendered with no metadata is exactly what it was before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildItemMetadataView, type ItemFacetEvidence, type ItemFacetName, type ItemMetadataView } from "@wowsync-dashboard/core/itemMetadata.ts";
import { InventoryCard } from "../src/components/CharacterDetail.tsx";
import GuildBankCard from "../src/components/GuildBankCard.tsx";
import SharedOwnerCard from "../src/components/SharedOwnerCard.tsx";
import { EMPTY_ITEM_INFO, ITEM_INFO_NOTE, buildItemInfoLookup, describeItemInfo, itemInfoSuffix } from "../src/itemMetadata.ts";
import { ItemInfoContext } from "../src/useItemInfo.ts";
import type { GuildBankSection, InventorySection } from "../src/types.ts";
import { WARBAND_OWNER, fmt, observation, ownerView } from "./sharedStorageFixtures.ts";

const render = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

const ev = (baseItemId: number, facet: ItemFacetName, value: number): ItemFacetEvidence => ({ gameVersion: "retail", baseItemId, facet, source: "game-client", value, firstSeenAt: 1, lastSeenAt: 1, clientBuilds: ["69875"] });
const viewOf = (id: number, facts: Partial<Record<ItemFacetName, number>>): ItemMetadataView =>
  buildItemMetadataView("retail", id, (Object.entries(facts) as Array<[ItemFacetName, number]>).map(([f, v]) => ev(id, f, v)));

const MOTE = viewOf(236949, { classID: 7, subclassID: 11, bindType: 0, expansionID: 11, isCraftingReagent: 1 });
const ELEMENTAL_MOTE = viewOf(202071, { classID: 15, subclassID: 0, bindType: 0, expansionID: 9, isCraftingReagent: 0 });
const SIX = viewOf(6666, { classID: 7, expansionID: 6 }); // a client value with no supported label
const CONFLICTED = { ...viewOf(60224, { classID: 7 }), ...buildItemMetadataView("retail", 60224, [ev(60224, "expansionID", 0), ev(60224, "expansionID", 3)]) };
const ONLY_CLASS = viewOf(777, { classID: 7, subclassID: 11 });

const LOOKUP = buildItemInfoLookup([ONLY_CLASS, SIX, ELEMENTAL_MOTE, MOTE].sort((a, b) => a.baseItemId - b.baseItemId));

test("describeItemInfo: a verified expansion and a crafting reagent read plainly; the summary states every part", () => {
  const d = describeItemInfo(MOTE);
  assert.deepEqual({ ...d }, { expansionText: "Midnight", expansionKnown: true, reagent: "yes", cell: "Midnight · Reagent", summary: "Midnight. Crafting reagent." });
});

test("compact lists are terse: 'Expansion unknown (N)', a positive Reagent only, nothing when nothing is known; the full wording stays in the tooltip", () => {
  assert.equal(itemInfoSuffix(MOTE), "Midnight · Reagent");
  assert.equal(itemInfoSuffix(ELEMENTAL_MOTE), "Dragonflight");
  assert.equal(itemInfoSuffix(viewOf(6, { expansionID: 0, isCraftingReagent: 0 })), "Expansion unknown (0)");
  assert.equal(itemInfoSuffix(viewOf(6, { expansionID: 254 })), "Expansion unknown (254)");
  assert.equal(itemInfoSuffix(viewOf(6, { isCraftingReagent: 0 })), "", "a known 'no' alone adds nothing to a compact list");
  assert.equal(itemInfoSuffix(viewOf(6, { isCraftingReagent: 1 })), "Reagent");
  assert.doesNotMatch(itemInfoSuffix(viewOf(6, { expansionID: 0 })), /classic/i);
  // the table cell and the tooltip still say everything
  assert.equal(describeItemInfo(viewOf(6, { expansionID: 0, isCraftingReagent: 0 })).cell, "Expansion unknown (client value 0) · Not a reagent");
  assert.equal(describeItemInfo(viewOf(6, { expansionID: 0, isCraftingReagent: 0 })).summary, "Expansion unknown (client value 0). Not a crafting reagent.");
});

test("describeItemInfo: a known 'no' is 'Not a reagent' - distinct from an unknown reagent status", () => {
  assert.equal(describeItemInfo(ELEMENTAL_MOTE).cell, "Dragonflight · Not a reagent");
  assert.equal(describeItemInfo(ELEMENTAL_MOTE).reagent, "no");
  const unknownReagent = describeItemInfo(viewOf(5, { expansionID: 10 }));
  assert.equal(unknownReagent.reagent, "unknown");
  assert.equal(unknownReagent.cell, "The War Within");
  assert.equal(unknownReagent.summary, "The War Within. Crafting reagent status unknown.");
});

test("describeItemInfo: an unsupported client value keeps its number in words and is not 'known'", () => {
  const d = describeItemInfo(SIX);
  assert.equal(d.expansionKnown, false);
  assert.equal(d.expansionText, "Expansion unknown (client value 6)");
  assert.equal(d.cell, "Expansion unknown (client value 6)");
});

test("describeItemInfo: 0 and 254 read as unknown client values, never Classic", () => {
  for (const raw of [0, 254]) {
    const d = describeItemInfo(viewOf(9, { expansionID: raw }));
    assert.equal(d.cell, `Expansion unknown (client value ${raw})`);
    assert.doesNotMatch(d.cell, /classic/i);
  }
});

test("describeItemInfo: conflicting client reports are shown as unknown, with both values, and no label", () => {
  const d = describeItemInfo(CONFLICTED);
  assert.equal(d.expansionKnown, false);
  assert.match(d.cell, /conflicting client values 0, 3/);
  assert.doesNotMatch(d.cell, /Mists|Cataclysm|Classic/);
});

test("describeItemInfo: nothing known at all is '?' (class/subclass alone say nothing about expansion or reagent)", () => {
  assert.equal(describeItemInfo(undefined).cell, "?");
  assert.equal(describeItemInfo(ONLY_CLASS).cell, "?");
  assert.equal(describeItemInfo(ONLY_CLASS).expansionText, "Expansion unknown");
  assert.equal(itemInfoSuffix(ONLY_CLASS), "", "compact lists gain no '?' noise");
});

test("the lookup keys on the strict base item id: embedded level and variant fields never matter, a non-item reference never matches", () => {
  assert.equal(LOOKUP.available, true);
  for (const ref of ["item:236949::::::::85:253:::::::::", "item:236949::::::::86:253:::::::::", "item:236949"]) assert.equal(LOOKUP.forItemRef(ref)?.baseItemId, 236949);
  for (const ref of [undefined, "", "?", "Mote of Light", "item:", "item:23694", "item:2369490"]) assert.equal(LOOKUP.forItemRef(ref), undefined, String(ref));
  assert.equal(EMPTY_ITEM_INFO.available, false);
  assert.equal(buildItemInfoLookup([]).available, false);
});

// --- one lookup, every store ------------------------------------------------------------------------------

const MOTE_REF = "item:236949::::::::85:253:::::::::";
const section = (over: Partial<InventorySection> = {}): InventorySection => ({
  status: { state: "OBSERVED", completeness: "complete", observedAt: 100 },
  itemsKnownEmpty: false,
  freeSlots: 10,
  totalSlots: 16,
  items: [
    { itemRef: MOTE_REF, name: "Mote of Light", qty: 13, bound: "no", vendorEachCopper: 2000 },
    { itemRef: "item:202071::::::::85:253:::::::::", name: "Elemental Mote", qty: 2 },
    { itemRef: "item:1234::::::::85:253:::::::::", name: "Unreported Thing", qty: 1 },
  ],
  ...over,
});
const guildSection = (): GuildBankSection => ({ ...section(), ownerScope: "GUILD", guildClubId: "1", guildName: "G", tabs: [] });

test("bags, Character Bank, carried Warband and carried Guild Bank all show the same Mote of Light info from one lookup", () => {
  const cards = {
    bags: render(createElement(InventoryCard, { title: "Bags", inv: section(), itemInfo: LOOKUP })),
    bank: render(createElement(InventoryCard, { title: "Bank", inv: section(), itemInfo: LOOKUP })),
    warband: render(createElement(InventoryCard, { title: "Warband Bank carried by this export", inv: section(), itemInfo: LOOKUP })),
    guild: render(createElement(GuildBankCard, { guild: guildSection(), itemInfo: LOOKUP, onOpenSharedStorage: noop })),
  };
  for (const [store, html] of Object.entries(cards)) {
    const t = text(html);
    assert.match(t, /Mote of Light × 13 — Midnight · Reagent/, store);
    assert.match(t, /Elemental Mote × 2 — Dragonflight(?! ·)/, `${store}: compact lists state only a positive reagent`);
    assert.match(html, /title="Dragonflight\. Not a crafting reagent\."/, `${store}: the tooltip has the full wording`);
    assert.match(t, /Unreported Thing × 1(?! —)/, `${store}: an unreported item gains nothing`);
  }
});

test("a list with no metadata renders exactly as before this feature: identical markup with the empty lookup, the default, or no prop", () => {
  const plain = render(createElement(InventoryCard, { title: "Bags", inv: section() }));
  assert.equal(render(createElement(InventoryCard, { title: "Bags", inv: section(), itemInfo: EMPTY_ITEM_INFO })), plain);
  assert.equal(render(createElement(InventoryCard, { title: "Bags", inv: section(), itemInfo: buildItemInfoLookup(undefined) })), plain);
  assert.doesNotMatch(plain, /item-info|Midnight|Reagent/);
  const guildPlain = render(createElement(GuildBankCard, { guild: guildSection(), onOpenSharedStorage: noop }));
  assert.equal(render(createElement(GuildBankCard, { guild: guildSection(), itemInfo: EMPTY_ITEM_INFO, onOpenSharedStorage: noop })), guildPlain);
});

test("the Shared Storage table gains an 'Item info' column only when metadata exists, with '?' for unreported items and an explanatory note", () => {
  const view = observation({ content: { ...observation().content, items: section().items } });
  const owner = ownerView(WARBAND_OWNER, { current: view });
  const card = () => render(createElement(SharedOwnerCard, { owner, anchorId: "shared-warband", onRequestClear: noop, formatTime: fmt }));
  const without = card();
  assert.doesNotMatch(without, /col-item-info|Item info/);

  const withInfo = render(createElement(ItemInfoContext.Provider, { value: LOOKUP }, createElement(SharedOwnerCard, { owner, anchorId: "shared-warband", onRequestClear: noop, formatTime: fmt })));
  const t = text(withInfo);
  assert.match(t, /Item info/);
  assert.match(withInfo, /<td class="col-item-info" title="Midnight\. Crafting reagent\." aria-label="Midnight\. Crafting reagent\.">Midnight · Reagent<\/td>/);
  assert.match(withInfo, /title="Dragonflight\. Not a crafting reagent\."[^>]*>Dragonflight · Not a reagent<\/td>/);
  assert.match(withInfo, /title="Expansion unknown\. Crafting reagent status unknown\."[^>]*><span class="muted">\?<\/span><\/td>/);
  assert.ok(t.includes(ITEM_INFO_NOTE));
  // Every original column is still there, and the original text is unchanged.
  for (const heading of ["Item", "Qty", "Bound", "Vendor each"]) assert.match(t, new RegExp(heading));
  assert.match(t, /Mote of Light 13 no/);
});

test("the item-info column stays out of the empty-filter row width bookkeeping (colSpan follows the column count)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/SharedOwnerCard.tsx", import.meta.url)), "utf8");
  assert.match(src, /colSpan=\{showInfo \? 5 : 4\}/);
});

test("metadata stays out of every excluded consumer's UI: totals, scoped facts, overview, economy/search, characters grid, Ask, developer export, import", () => {
  const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
  for (const file of ["totals.ts", "scopedFacts.ts", "components/AccountOverview.tsx", "components/AccountEconomy.tsx", "components/CharactersGrid.tsx", "components/AskAccountModal.tsx", "components/DeveloperExportModal.tsx", "components/ImportModal.tsx", "importOutcome.ts"]) {
    assert.doesNotMatch(src(file), /itemMetadata|useItemInfo|ItemInfo|item-metadata/, `${file} must not read item metadata`);
  }
});

test("the web app derives no expansion label of its own: it only words what the server resolved", () => {
  // Program text only: comments may quote example wording, but no label may exist in the code.
  const src = readFileSync(fileURLToPath(new URL("../src/itemMetadata.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["Midnight", "Dragonflight", "Shadowlands", "Mists of Pandaria", "The War Within"]) assert.equal(src.includes(name), false, `${name} must come from the server's view`);
});
