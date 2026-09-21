// Retail Guild Bank ([GUILD BANK]) compatibility.
//
// The current addon ALWAYS emits [ACCOUNT BANK] and [GUILD BANK] on Retail
// (UNKNOWN when never observed), so a parser that rejects either would make
// every current Retail export un-importable. Shapes below follow
// GearExport/WoWSyncRender.lua @ 3e9c6bf (renderers.guildBank) and the
// collector's real tab states (OBSERVED / UNKNOWN / INACCESSIBLE).
//
// Trust rules under test (nothing is inferred from missing data):
//   - UNKNOWN stays UNKNOWN: never an empty or zero-slot bank.
//   - LAST_SEEN stays LAST_SEEN: never presented as currently OBSERVED.
//   - An INACCESSIBLE tab stays INACCESSIBLE: never a known-empty tab.
//   - Guild storage is its own scope: separate from the character bank and the
//     Warband bank, and (until shared-storage reconciliation exists) it is NOT in
//     account totals, item search, diffs, or the LLM context.
// The fixture is DERIVED (the real Ezaller Retail export with storage sections
// populated in the addon's format), not a live capture - see fixtures/README.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildLlmContext } from "../src/llmContext.ts";
import { parseWowSyncExport, WowSyncParseError } from "../src/parser.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const FIXTURE = readFileSync(`${dir}derived/ezaller-shared-storage-1789478317.wowsync.txt`, "utf8");
const T = "\t";

/** The fixture with its [GUILD BANK] block replaced. */
function withGuildBlock(block: string): string {
  const replaced = FIXTURE.replace(/\[GUILD BANK\][\s\S]*?(?=\n\n\[PROFESSIONS\])/, block);
  assert.notEqual(replaced, FIXTURE);
  return replaced;
}

const GUILD_HEAD = [
  "LastVisit: 1789478100",
  "VisitedNPC: Guild Vault",
  "VisitedZone: Stormwind City",
];
const GUILD_IDENT = [
  "Scope: GUILD",
  "GuildClubID: 18014398509481985",
  "GuildName: Fixture Guild",
  "Coverage: All tabs currently reported viewable were serialized through QueryGuildBankTab; inaccessible tabs were not scanned.",
  "SnapshotVisit: 1789478100",
];
const TAB_HEADER = ["tab", "name", "viewable", "state", "note"].join(T);
const CONTAINER_HEADER = ["container", "capacity", "free", "family", "bagRef"].join(T);
const ITEM_HEADER = ["itemRef", "name", "qty", "bound", "vendorEachCopper"].join(T);

// --- The derived fixture: all three storage scopes -----------------------------------------------

test("[DERIVED] a current-format Retail export with [BANK] + [ACCOUNT BANK] + [GUILD BANK] parses, and the three scopes stay separate", () => {
  const p = parseWowSyncExport(FIXTURE);

  // Character bank: its own scope and contents.
  assert.equal(p.bank.status.state, "OBSERVED");
  assert.deepEqual(p.bank.items.map((i) => i.name), ["Wool Cloth"]);

  // Warband bank: account scope, its own contents.
  assert.equal(p.accountBank?.ownerScope, "ACCOUNT_WARBAND");
  assert.equal(p.accountBank?.status.state, "OBSERVED");
  assert.deepEqual(p.accountBank?.items.map((i) => i.name), ["Netherweave Cloth"]);

  // Guild bank: guild scope, its own contents and provenance.
  const g = p.guildBank!;
  assert.equal(g.ownerScope, "GUILD");
  assert.equal(g.status.state, "OBSERVED");
  assert.equal(g.status.completeness, "complete");
  assert.equal(g.status.observedAt, 1789478160);
  assert.equal(g.status.lastVisit, 1789478100);
  assert.equal(g.status.visitedNPC, "Guild Vault");
  assert.equal(g.status.visitedZone, "Stormwind City");
  assert.equal(g.guildName, "Fixture Guild");
  assert.equal(g.snapshotVisit, 1789478100);
  assert.match(g.coverage ?? "", /inaccessible tabs were not scanned/);
  assert.deepEqual(g.items.map((i) => i.name), ["Linen Cloth", "Copper Ore"]);
  assert.deepEqual(g.items.map((i) => i.qty), [40, 20]);
  assert.deepEqual(g.containers.map((c) => [c.id, c.storage, c.capacity, c.free]), [
    [1, "GUILD", 98, 95],
    [2, "GUILD", 98, 98],
  ]);
  assert.equal(g.freeSlots, 193);
  assert.equal(g.totalSlots, 196);

  // No cross-contamination between the three scopes.
  const names = (s: { items: { name?: string }[] }) => s.items.map((i) => i.name);
  for (const other of ["Linen Cloth", "Copper Ore", "Netherweave Cloth"]) assert.ok(!names(p.bank).includes(other));
  for (const other of ["Wool Cloth", "Linen Cloth", "Copper Ore"]) assert.ok(!names(p.accountBank!).includes(other));
  for (const other of ["Wool Cloth", "Netherweave Cloth"]) assert.ok(!names(g).includes(other));
  assert.notEqual(p.bank.status.observedAt, g.status.observedAt);
});

test("the export without the storage extensions still parses unchanged (older addon builds)", () => {
  const real = readFileSync(`${dir}retail/ezaller-1789478317.wowsync.txt`, "utf8");
  const p = parseWowSyncExport(real);
  assert.equal(p.guildBank, undefined);
  assert.equal(p.accountBank, undefined);
});

// --- A. UNKNOWN / never observed ------------------------------------------------------------------------

test("A. an UNKNOWN Guild Bank (what EVERY Retail export carries until a guild bank is opened) parses and stays UNKNOWN - not empty, not zero slots", () => {
  const p = parseWowSyncExport(withGuildBlock("[GUILD BANK]\nState: UNKNOWN\nScope: GUILD\nReason: Not observed"));
  const g = p.guildBank!;
  assert.equal(g.status.state, "UNKNOWN");
  assert.equal(g.ownerScope, "GUILD");
  assert.equal(g.status.reason, "Not observed", "the addon's reason is retained even though Scope sits between State and Reason");
  assert.deepEqual(g.tabs, []);
  assert.deepEqual(g.containers, []);
  assert.deepEqual(g.items, []);
  assert.equal(g.itemsKnownEmpty, false, "unknown contents are never 'known empty'");
  assert.equal(g.freeSlots, undefined);
  assert.equal(g.totalSlots, undefined);
  assert.equal(g.guildName, undefined);
  assert.equal(g.guildClubId, undefined);
});

test("A. UNKNOWN with the collector's real reasons (identity not ready, closed, timed out) keeps the reason verbatim", () => {
  for (const reason of ["Guild Bank identity was not ready", "Guild Bank closed before query response", "Guild Bank query response timed out"]) {
    const g = parseWowSyncExport(withGuildBlock(`[GUILD BANK]\nState: UNKNOWN\nScope: GUILD\nReason: ${reason}`)).guildBank!;
    assert.equal(g.status.state, "UNKNOWN");
    assert.equal(g.status.reason, reason);
  }
});

test("A. an UNKNOWN Guild Bank without a Scope line (defensive) still parses", () => {
  const g = parseWowSyncExport(withGuildBlock("[GUILD BANK]\nState: UNKNOWN\nReason: Not observed")).guildBank!;
  assert.equal(g.status.state, "UNKNOWN");
  assert.equal(g.status.reason, "Not observed");
});

// --- B. OBSERVED complete, populated tabs ------------------------------------------------------------------

test("B. OBSERVED complete with populated tabs: tabs, containers, slots and items are all retained", () => {
  const g = parseWowSyncExport(FIXTURE).guildBank!;
  assert.deepEqual(
    g.tabs.map((t) => [t.id, t.name, t.viewable, t.state, t.note]),
    [
      [1, "Materials", true, "OBSERVED", undefined],
      [2, "Empty Tab", true, "OBSERVED", undefined],
      [3, "Officers", false, "INACCESSIBLE", undefined],
    ],
  );
  assert.equal(g.itemsKnownEmpty, false);
  assert.deepEqual(g.items[0], { itemRef: "item:2589::::::::70:::::::::", name: "Linen Cloth", qty: 40, bound: "no", vendorEachCopper: 13 });
});

// --- C. OBSERVED complete with a genuinely empty viewable tab ---------------------------------------------------

test("C. a viewable tab observed EMPTY is a known empty (Items: EMPTY), distinct from unknown and inaccessible", () => {
  const block = [
    "[GUILD BANK]",
    ...GUILD_HEAD,
    "State: OBSERVED; complete; observed=1789478160",
    ...GUILD_IDENT,
    TAB_HEADER,
    ["1", "Empty Tab", "yes", "OBSERVED", "?"].join(T),
    CONTAINER_HEADER,
    "ContainerStorage 1: GUILD",
    ["1", "98", "98", "?", "-"].join(T),
    "Slots: 98 free / 98",
    ITEM_HEADER,
    "Items: EMPTY",
  ].join("\n");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.equal(g.status.state, "OBSERVED");
  assert.equal(g.itemsKnownEmpty, true);
  assert.deepEqual(g.items, []);
  assert.equal(g.tabs[0].state, "OBSERVED");
  assert.equal(g.tabs[0].viewable, true);
  assert.equal(g.freeSlots, 98);
  assert.equal(g.totalSlots, 98);
});

// --- D. LAST_SEEN ------------------------------------------------------------------------------------------------

test("D. LAST_SEEN complete stays LAST_SEEN with its ORIGINAL observation time - never rewritten to OBSERVED", () => {
  const block = FIXTURE.match(/\[GUILD BANK\][\s\S]*?(?=\n\n\[PROFESSIONS\])/)![0].replace(
    "State: OBSERVED; complete; observed=1789478160",
    "State: LAST_SEEN; complete; observed=1789478160",
  );
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.equal(g.status.state, "LAST_SEEN");
  assert.equal(g.status.completeness, "complete");
  assert.equal(g.status.observedAt, 1789478160, "the time of the last real observation, not the export time");
  assert.equal(g.status.observedAt! < 1789478317, true, "older than the export that carried it");
  assert.equal(g.items.length, 2, "the retained prior observation's contents are kept");
  assert.equal(g.tabs.length, 3);
});

// --- E. INACCESSIBLE tabs -------------------------------------------------------------------------------------------

test("E. an INACCESSIBLE tab stays INACCESSIBLE (viewable: false) and is never converted into an empty observed tab", () => {
  const g = parseWowSyncExport(FIXTURE).guildBank!;
  const officers = g.tabs.find((t) => t.name === "Officers")!;
  assert.equal(officers.state, "INACCESSIBLE");
  assert.equal(officers.viewable, false);
  // No container or item is attributed to it, and the summary does not pretend it was scanned.
  assert.equal(g.containers.some((c) => c.id === officers.id), false);
  assert.equal(g.tabs.filter((t) => t.state === "OBSERVED").length, 2);
});

test("E. every tab inaccessible: nothing observed - contents are NOT 'known empty' (the addon omits Items: EMPTY here)", () => {
  const block = [
    "[GUILD BANK]",
    ...GUILD_HEAD,
    "State: OBSERVED; complete; observed=1789478160",
    ...GUILD_IDENT,
    TAB_HEADER,
    ["1", "Officers", "no", "INACCESSIBLE", "?"].join(T),
    ["2", "Leaders", "no", "INACCESSIBLE", "?"].join(T),
    CONTAINER_HEADER,
    "Slots: 0 free / 0",
    ITEM_HEADER,
  ].join("\n");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.deepEqual(g.tabs.map((t) => t.state), ["INACCESSIBLE", "INACCESSIBLE"]);
  assert.equal(g.itemsKnownEmpty, false);
  assert.deepEqual(g.items, []);
  assert.deepEqual(g.containers, []);
});

test("a PARTIAL capture (a viewable tab not confirmed) keeps its partial completeness, the reason, and that tab as UNKNOWN", () => {
  const block = [
    "[GUILD BANK]",
    ...GUILD_HEAD,
    "State: OBSERVED; partial; observed=1789478160",
    "CoverageNote: Guild Bank query response timed out",
    ...GUILD_IDENT,
    TAB_HEADER,
    ["1", "Materials", "yes", "OBSERVED", "?"].join(T),
    ["2", "Consumables", "yes", "UNKNOWN", "Guild Bank query response timed out"].join(T),
    CONTAINER_HEADER,
    "ContainerStorage 1: GUILD",
    ["1", "98", "95", "?", "-"].join(T),
    "Slots: 95 free / 98",
    ITEM_HEADER,
    ["item:2589::::::::70:::::::::", "Linen Cloth", "40", "no", "13"].join(T),
  ].join("\n");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.equal(g.status.state, "OBSERVED");
  assert.equal(g.status.completeness, "partial");
  assert.equal(g.status.coverageNote, "Guild Bank query response timed out");
  const t2 = g.tabs[1];
  assert.equal(t2.state, "UNKNOWN");
  assert.equal(t2.viewable, true);
  assert.equal(t2.note, "Guild Bank query response timed out");
  assert.equal(g.itemsKnownEmpty, false);
  assert.equal(g.containers.length, 1, "no container is invented for the unconfirmed tab");
});

// --- Identity, provenance and conservative parsing ------------------------------------------------------------------

test("GuildClubID is kept as a STRING: an identifier above 2^53 must not be rounded by Number()", () => {
  const g = parseWowSyncExport(FIXTURE).guildBank!;
  assert.equal(g.guildClubId, "18014398509481985");
  assert.equal(typeof g.guildClubId, "string");
  assert.notEqual(String(Number("18014398509481985")), "18014398509481985", "sanity: Number() really would corrupt this identifier");
});

test("GuildClubID and GuildName survive persistence in SQLite exactly (string identity, unescaped name)", () => {
  const block = FIXTURE.match(/\[GUILD BANK\][\s\S]*?(?=\n\n\[PROFESSIONS\])/)![0]
    .replace("GuildClubID: 18014398509481985", "GuildClubID: 9223372036854775807")
    .replace("GuildName: Fixture Guild", "GuildName: Les Chevaliers\\tde l'Ordre \\\\ Ltd");
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const { snapshot } = store.importSnapshot(withGuildBlock(block));
    const g = store.getSnapshot(snapshot.id)!.parsed.guildBank!;
    assert.equal(g.guildClubId, "9223372036854775807");
    assert.equal(g.guildName, "Les Chevaliers\tde l'Ordre \\ Ltd");
  } finally {
    store.close();
  }
});

test("unknown identity values stay unknown: '?' club id/name are undefined, never '?' strings or 0", () => {
  const block = FIXTURE.match(/\[GUILD BANK\][\s\S]*?(?=\n\n\[PROFESSIONS\])/)![0]
    .replace("GuildClubID: 18014398509481985", "GuildClubID: ?")
    .replace("GuildName: Fixture Guild", "GuildName: ?");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.equal(g.guildClubId, undefined);
  assert.equal(g.guildName, undefined);
});

test("tab rows tolerate dropped trailing columns and unfamiliar states without failing the whole import, and never invent values", () => {
  const block = [
    "[GUILD BANK]",
    ...GUILD_HEAD,
    "State: OBSERVED; complete; observed=1789478160",
    ...GUILD_IDENT,
    TAB_HEADER,
    ["1", "Materials", "yes", "OBSERVED"].join(T), // note column dropped entirely
    ["2", "Future Tab", "?", "SOME_FUTURE_STATE", "hello"].join(T),
    ["?", "?", "?", "?", "?"].join(T),
    CONTAINER_HEADER,
    "ContainerStorage 1: GUILD",
    ["1", "98", "98", "?", "-"].join(T),
    "Slots: 98 free / 98",
    ITEM_HEADER,
    "Items: EMPTY",
  ].join("\n");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.deepEqual(g.tabs[0], { id: 1, name: "Materials", viewable: true, state: "OBSERVED", note: undefined });
  assert.deepEqual(g.tabs[1], { id: 2, name: "Future Tab", viewable: undefined, state: "SOME_FUTURE_STATE", note: "hello" });
  assert.deepEqual(g.tabs[2], { id: undefined, name: undefined, viewable: undefined, state: undefined, note: undefined });
});

test("a Guild Bank with no tab table at all still parses (tabs: []), rather than failing the import", () => {
  const block = [
    "[GUILD BANK]",
    "State: OBSERVED; complete; observed=1789478160",
    ...GUILD_IDENT,
    CONTAINER_HEADER,
    "Slots: 0 free / 0",
    ITEM_HEADER,
  ].join("\n");
  const g = parseWowSyncExport(withGuildBlock(block)).guildBank!;
  assert.deepEqual(g.tabs, []);
});

// --- Contract violations are still rejected ----------------------------------------------------------------------------

test("a [GUILD BANK] in a non-Retail export is rejected (Guild Bank capture is Retail-only)", () => {
  const classic = buildWowSyncExport({ character: { name: "Old", realm: "R", clientVersion: "1.15.9", clientBuild: "1" } });
  const withGuild = classic.replace("[PROFESSIONS]", "[GUILD BANK]\nState: UNKNOWN\nScope: GUILD\nReason: Not observed\n\n[PROFESSIONS]");
  assert.throws(() => parseWowSyncExport(withGuild), (e: unknown) => e instanceof WowSyncParseError && /only valid for a Retail export/.test(e.message));
});

test("a [GUILD BANK] with a scope other than GUILD, or a duplicated section, is rejected - never guessed at", () => {
  const badScope = FIXTURE.replace("Scope: GUILD", "Scope: CHARACTER");
  assert.throws(() => parseWowSyncExport(badScope), (e: unknown) => e instanceof WowSyncParseError && /Unsupported guild-bank scope/.test(e.message));
  const twice = FIXTURE.replace("[PROFESSIONS]", "[GUILD BANK]\nState: UNKNOWN\nScope: GUILD\nReason: Not observed\n\n[PROFESSIONS]");
  assert.throws(() => parseWowSyncExport(twice), (e: unknown) => e instanceof WowSyncParseError && /Duplicate section/.test(e.message));
});

test("other unknown sections are still rejected (only the documented Guild Bank extension was added)", () => {
  const other = FIXTURE.replace("[PROFESSIONS]", "[SOMETHING NEW]\nState: UNKNOWN\n\n[PROFESSIONS]");
  assert.throws(() => parseWowSyncExport(other), (e: unknown) => e instanceof WowSyncParseError && /Unknown section "\[SOMETHING NEW\]"/.test(e.message));
});

// --- Warband: the same real UNKNOWN shape (State/Scope/Reason) keeps its reason ---------------------------------

test("an UNKNOWN Warband Bank in the addon's real shape (State/Scope/Reason) keeps its reason, and coexists with a Guild Bank", () => {
  const unknownAccount = "[ACCOUNT BANK]\nState: UNKNOWN\nScope: ACCOUNT_WARBAND\nReason: Not observed";
  const text = FIXTURE.replace(/\[ACCOUNT BANK\][\s\S]*?(?=\n\n\[GUILD BANK\])/, unknownAccount);
  const p = parseWowSyncExport(text);
  assert.equal(p.accountBank?.status.state, "UNKNOWN");
  assert.equal(p.accountBank?.status.reason, "Not observed");
  assert.equal(p.accountBank?.itemsKnownEmpty, false);
  assert.equal(p.guildBank?.status.state, "OBSERVED");
});

// --- Import path: stored, retrievable, and NOT leaking into shared totals -----------------------------------------------

test("[DERIVED] the export imports through the store, and the Guild Bank is retained in the stored snapshot", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const result = store.importSnapshot(FIXTURE);
    assert.equal(result.character.version, "retail");
    assert.equal(result.isDuplicate, false);
    const stored = store.getSnapshot(result.snapshot.id)!.parsed;
    assert.equal(stored.guildBank?.guildName, "Fixture Guild");
    assert.equal(stored.guildBank?.tabs.length, 3);
    assert.equal(stored.accountBank?.items[0].name, "Netherweave Cloth");
    assert.equal(store.importSnapshot(FIXTURE).isDuplicate, true, "re-importing the same export is still idempotent");
  } finally {
    store.close();
  }
});

test("[DERIVED] Guild Bank contents are NOT in account inventory, item search, totals, diffs, AccountContext, or the LLM context (deferred until shared-storage reconciliation)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(FIXTURE);
    // A second, later snapshot whose guild bank changed: diffs must still ignore guild storage.
    const changed = FIXTURE.replace("Linen Cloth\t40", "Linen Cloth\t400").replace("Generated: 1789478317", "Generated: 1789478417");
    const second = store.importSnapshot(changed);
    assert.equal(second.diff?.bagsItems.length, 0);
    assert.equal(second.diff?.bankItems.length, 0);

    const facts = store.buildAccountFacts("retail", 1789480000);
    const inventoryNames = facts.inventory.items.map((i) => i.name);
    for (const shared of ["Linen Cloth", "Copper Ore", "Netherweave Cloth"]) {
      assert.equal(inventoryNames.includes(shared), false, `${shared} (shared storage) must not appear in the character inventory aggregate`);
    }
    assert.ok(inventoryNames.includes("Wool Cloth"), "the CHARACTER bank's own item still does");
    assert.deepEqual(new Set(facts.inventory.items.flatMap((i) => i.locations.map((l) => l.storage))), new Set(["bags", "bank"]));

    const ctx = store.buildAccountContext(1789480000);
    const serialized = JSON.stringify(ctx) + JSON.stringify(buildLlmContext(ctx));
    for (const shared of ["Linen Cloth", "Copper Ore", "Fixture Guild", "18014398509481985", "Netherweave Cloth", "GUILD"]) {
      assert.equal(serialized.includes(shared), false, `${shared} must not reach AccountContext / LlmContext yet`);
    }
  } finally {
    store.close();
  }
});
