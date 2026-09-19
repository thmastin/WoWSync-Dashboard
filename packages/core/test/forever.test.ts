// Forever (Classic beta client, ClientFamily: Forever) as a first-class
// version. Primary validation is against the REAL Hallo Emberstone exports
// captured from the actual Forever beta (Classic Beta PvP 2): a level-4
// capture (build 69893, almost everything UNKNOWN) and a level-7 capture
// (build 69913, equipment/bags/professions observed). Synthetic fixtures
// are used only for what the real data cannot show (a second Forever
// realm, malformed input, a playtime-observed shape) and are labelled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAccountContext } from "../src/accountContext.ts";
import { formatCopper } from "../src/currency.ts";
import { buildLlmContext } from "../src/llmContext.ts";
import { parseWowSyncExport, WowSyncParseError } from "../src/parser.ts";
import { professionCatalogForVersion, professionEntryIsEvidence } from "../src/professionCatalog.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { UNKNOWN_VERSION } from "../src/types.ts";
import { VERSION_LABELS, WOW_VERSIONS, detectVersion } from "../src/version.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const LEVEL4 = "forever/hallo-1789693144.wowsync.txt";
const LEVEL7 = "forever/hallo-1789731867.wowsync.txt";
const HALLO_KEY = "forever::classic beta pvp 2::hallo emberstone";
// Just after the level-7 capture, so freshness is deterministic.
const NOW_RECENT = 1789731867 + 3600;
const NOW_STALE = 1789731867 + 30 * 86400;

const FOREVER = { clientVersion: "1.60.1", clientBuild: "69913", clientFamily: "Forever", interface: "16001" };

function halloStore(): SqliteSnapshotStore {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(read(LEVEL4));
  store.importSnapshot(read(LEVEL7));
  return store;
}

// --- Version recognition ---------------------------------------------------

test("[REAL] Hallo's exports are recognized as Forever, not Classic Era, despite the 1.x client number", () => {
  for (const file of [LEVEL4, LEVEL7]) {
    const parsed = parseWowSyncExport(read(file));
    assert.equal(parsed.character.clientVersion, "1.60.1");
    assert.equal(parsed.character.clientFamily, "Forever");
    assert.equal(detectVersion(parsed.character), "forever");
  }
});

test("Forever is a registered version with its own label and is listed alongside the others", () => {
  assert.ok(WOW_VERSIONS.includes("forever"));
  assert.equal(VERSION_LABELS["forever"], "Forever");
  assert.deepEqual([...WOW_VERSIONS], ["classic-era", "tbc-anniversary", "retail", "forever"]);
});

test("[SYNTHETIC] ClientFamily matching is case-insensitive; an unrecognized family is quarantined, never guessed into Forever or Classic Era", () => {
  const route = (family: string) =>
    detectVersion(parseWowSyncExport(buildWowSyncExport({ character: { ...FOREVER, clientFamily: family } })).character);
  assert.equal(route("FOREVER"), "forever");
  assert.equal(route("forever"), "forever");
  assert.equal(route("SomethingNew"), UNKNOWN_VERSION);
});

test("[SYNTHETIC] a bare 1.x client with no ClientFamily still routes to Classic Era (existing behavior unchanged)", () => {
  const parsed = parseWowSyncExport(buildWowSyncExport({ character: { clientVersion: "1.15.7", clientBuild: "60927" } }));
  assert.equal(detectVersion(parsed.character), "classic-era");
});

// --- Import, identity, preserved client metadata ----------------------------

test("[REAL] importing Hallo creates one Forever character with realm-qualified identity and preserved client metadata", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const first = store.importSnapshot(read(LEVEL4));
    assert.equal(first.character.version, "forever");
    assert.equal(first.character.identityKey, HALLO_KEY);
    assert.equal(first.character.realm, "Classic Beta PvP 2");
    assert.equal(first.character.class, "HUNTER");
    assert.equal(first.character.faction, "Alliance");
    assert.equal(first.isFirstSnapshot, true);

    const second = store.importSnapshot(read(LEVEL7));
    assert.equal(second.character.identityKey, HALLO_KEY, "same character, same identity across both captures");
    assert.equal(second.character.snapshotCount, 2);
    assert.equal(store.listCharacters("forever").length, 1);

    // Client metadata (family/interface/build) survives in the stored snapshot; the build advanced between captures.
    const [newest, oldest] = store.listSnapshots(HALLO_KEY);
    assert.equal(oldest.parsed.character.clientBuild, "69893");
    assert.equal(newest.parsed.character.clientBuild, "69913");
    for (const s of [oldest, newest]) {
      assert.equal(s.parsed.character.clientFamily, "Forever");
      assert.equal(s.parsed.character.interface, "16001");
      assert.equal(s.parsed.raw.startsWith("WOWSYNC v1"), true);
    }
  } finally {
    store.close();
  }
});

test("[REAL] the level-7 Hallo capture carries exactly the observed values, with UNKNOWN sections left UNKNOWN", () => {
  const p = parseWowSyncExport(read(LEVEL7));
  assert.equal(p.character.level, 7);
  assert.equal(p.character.moneyCopper, 291);
  assert.equal(p.character.xp, 1850);
  assert.equal(p.character.xpMax, 4500);
  assert.equal(p.character.playedSeconds, undefined, "this capture rendered PlayedSeconds as ? - it must stay unknown, not 0");
  assert.equal(p.character.levelPlayedSeconds, undefined);
  assert.equal(p.location.zone, "Dun Morogh");
  assert.equal(p.equipment.status.state, "OBSERVED");
  assert.equal(p.equipment.status.completeness, "partial");
  assert.equal(p.equipment.slots.filter((s) => !s.empty).length, 9);
  assert.equal(p.bags.status.state, "OBSERVED");
  assert.equal(p.bags.items.find((i) => i.name === "Light Shot")?.qty, 587);
  assert.equal(p.professions.status.state, "OBSERVED");
  assert.equal(p.professions.status.completeness, "partial");
  // Never fabricated: the addon has not observed these yet.
  assert.equal(p.bank.status.state, "UNKNOWN");
  assert.equal(p.spells.status.state, "UNKNOWN");
  assert.equal(p.trainer.status.state, "UNKNOWN");
});

// --- Character history / diffs ---------------------------------------------

test("[REAL] the level 4 -> 7 transition reports observed deltas only; UNKNOWN -> OBSERVED sections are not fabricated into gains", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read(LEVEL4));
    const { diff } = store.importSnapshot(read(LEVEL7));
    assert.ok(diff);
    assert.equal(diff.level.delta, 3);
    assert.equal(diff.moneyCopper.from, 55);
    assert.equal(diff.moneyCopper.to, 291);
    assert.equal(diff.moneyCopper.delta, 236);
    assert.equal(diff.playedSeconds.delta, undefined, "playtime was never observed on either side");
    assert.equal(diff.location.changed, true);
    assert.equal(diff.location.fromZone, "Anvilmar");
    assert.equal(diff.location.toZone, "Dun Morogh");
    // Bags/equipment/professions were UNKNOWN in the level-4 capture: no "everything was gained" delta.
    assert.deepEqual(diff.bagsItems, []);
    assert.deepEqual(diff.equipment, []);
    assert.deepEqual(diff.professions, []);
  } finally {
    store.close();
  }
});

test("[REAL] recent changes for Forever surface Hallo's observed level/gold/location change", () => {
  const store = halloStore();
  try {
    const changes = store.recentChanges("forever");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].identityKey, HALLO_KEY);
    assert.equal(changes[0].diff.level.delta, 3);
    assert.deepEqual(store.recentChanges("classic-era"), []);
  } finally {
    store.close();
  }
});

// --- AccountFacts -----------------------------------------------------------

test("[REAL] Forever AccountFacts: realm-partitioned, real gold/level/XP, bank honestly UNKNOWN", () => {
  const store = halloStore();
  try {
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.equal(facts.version, "forever");
    assert.equal(facts.aggregationScope, "realm");
    assert.equal(facts.characterCount, 1);
    assert.equal(facts.realms.length, 1);
    assert.equal(facts.realms[0].realm, "Classic Beta PvP 2");

    const hallo = facts.characters[0];
    assert.equal(hallo.level, 7);
    assert.equal(hallo.goldCopper, 291);
    assert.equal(hallo.xp, 1850);
    assert.equal(hallo.xpPercent, (1850 / 4500) * 100);
    assert.equal(hallo.freshness, "recent");
    assert.equal(hallo.bankStatus, "UNKNOWN");
    assert.equal(hallo.snapshotCount, 2);

    assert.equal(facts.gold.totalKnownCopper, 291);
    assert.equal(facts.realms[0].gold.totalKnownCopper, 291);
    assert.equal(facts.progression.recentLevelUps.length, 1);
    assert.deepEqual(
      { from: facts.progression.recentLevelUps[0].fromLevel, to: facts.progression.recentLevelUps[0].toLevel },
      { from: 4, to: 7 },
    );
    assert.equal(facts.recentChanges.length, 1);
  } finally {
    store.close();
  }
});

test("[REAL] Forever freshness is classified from the capture time and the passed-in clock only", () => {
  const store = halloStore();
  try {
    assert.equal(store.buildAccountFacts("forever", NOW_RECENT).freshness.recentCharacters, 1);
    const stale = store.buildAccountFacts("forever", NOW_STALE);
    assert.equal(stale.freshness.staleCharacters, 1);
    assert.equal(stale.characters[0].freshness, "stale");
    // Pure/deterministic: same input, same output.
    assert.deepEqual(store.buildAccountFacts("forever", NOW_RECENT), store.buildAccountFacts("forever", NOW_RECENT));
  } finally {
    store.close();
  }
});

test("[REAL] Forever playtime is UNKNOWN (not 0) when the export rendered PlayedSeconds as ?", () => {
  const store = halloStore();
  try {
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.equal(facts.playtime.charactersWithKnownPlaytime, 0);
    assert.equal(facts.playtime.byCharacter[0].playedSeconds, undefined);
    assert.equal(facts.characters[0].playedSeconds, undefined);
    assert.equal(facts.characters[0].levelPlayedSeconds, undefined);
  } finally {
    store.close();
  }
});

test("[DERIVED] Forever playtime flows through when observed - the real level-7 export with the user-reported /played values (9206s total, 1757s this level) substituted for its '?' lines", () => {
  // The full capture that carried these values was not available on disk;
  // the exact user-reported numbers are substituted into the real level-7
  // text so the playtime path is exercised on a real Forever export shape.
  const derived = read(LEVEL7)
    .replace("PlayedSeconds: ?", "PlayedSeconds: 9206")
    .replace("LevelPlayedSeconds: ?", "LevelPlayedSeconds: 1757");
  assert.notEqual(derived, read(LEVEL7));
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(derived);
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.equal(facts.characters[0].playedSeconds, 9206);
    assert.equal(facts.characters[0].levelPlayedSeconds, 1757);
    assert.equal(facts.playtime.totalKnownPlayedSeconds, 9206);
    assert.equal(facts.playtime.charactersWithKnownPlaytime, 1);
    assert.equal(facts.realms[0].playtime.totalKnownPlayedSeconds, 9206);
  } finally {
    store.close();
  }
});

// --- Inventory aggregation ---------------------------------------------------

test("[REAL] Forever inventory aggregates observed bags and never invents a bank", () => {
  const store = halloStore();
  try {
    const inv = store.buildAccountFacts("forever", NOW_RECENT).inventory;
    const lightShot = inv.items.find((i) => i.name === "Light Shot");
    assert.ok(lightShot);
    assert.equal(lightShot.totalKnownQty, 587);
    assert.deepEqual(
      lightShot.locations.map((l) => l.storage),
      ["bags"],
    );
    assert.equal(inv.items.length, 22, "the 22 distinct bag items observed in the real capture");
    assert.ok(inv.items.every((i) => i.locations.every((l) => l.storage === "bags")), "no bank locations exist anywhere");
    assert.deepEqual(inv.unknownBank, [{ identityKey: HALLO_KEY, name: "Hallo Emberstone" }]);
    assert.deepEqual(inv.unknownBags, []);
    assert.equal(inv.hasUnknownStorage, true);
  } finally {
    store.close();
  }
});

test("[REAL] a Forever character whose bags/bank/professions were never observed (level-4 capture) stays UNKNOWN everywhere", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read(LEVEL4));
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.deepEqual(facts.inventory.items, []);
    assert.equal(facts.inventory.unknownBags.length, 1);
    assert.equal(facts.inventory.unknownBank.length, 1);
    assert.equal(facts.professions.byCharacter[0].observationStatus, "UNKNOWN");
    assert.deepEqual(facts.professions.byCharacter[0].professions, []);
    // Nothing observed -> nothing listed. In particular no profession is reported as "none".
    assert.deepEqual(facts.professions.coverage, []);
    assert.equal(facts.characters[0].playedSeconds, undefined);
  } finally {
    store.close();
  }
});

// --- Profession coverage ----------------------------------------------------

test("Forever has no hardcoded profession catalog (Classic/TBC lists are never applied to it)", () => {
  assert.deepEqual(professionCatalogForVersion("forever"), []);
  assert.ok(professionCatalogForVersion("classic-era").length > 0);
});

test("only Forever treats 0/0 profession entries as non-evidence; other versions are unchanged", () => {
  const zero = { skill: 0, maxSkill: 0 };
  assert.equal(professionEntryIsEvidence("forever", zero), false);
  assert.equal(professionEntryIsEvidence("forever", {}), false);
  assert.equal(professionEntryIsEvidence("forever", { skill: 20, maxSkill: 75 }), true);
  assert.equal(professionEntryIsEvidence("forever", { skill: 0, maxSkill: 75 }), true);
  for (const v of ["classic-era", "tbc-anniversary", "retail", "unknown-version"] as const) {
    assert.equal(professionEntryIsEvidence(v, zero), true);
  }
});

test("[REAL] Forever coverage comes only from the export: Engineering/Mining covered; 0/0 rows are unknown - never covered, never none", () => {
  const store = halloStore();
  try {
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    const cov = new Map(facts.professions.coverage.map((c) => [c.profession, c]));

    assert.equal(cov.get("Engineering")?.coverageStatus, "covered");
    assert.deepEqual(cov.get("Engineering")?.characters, [
      { identityKey: HALLO_KEY, name: "Hallo Emberstone", skill: 20, maxSkill: 75 },
    ]);
    assert.equal(cov.get("Mining")?.coverageStatus, "covered");
    assert.equal(cov.get("Mining")?.characters[0].skill, 22);

    for (const zeroRow of ["Alchemy", "Blacksmithing", "Enchanting", "Herbalism", "Leatherworking", "Skinning", "Tailoring"]) {
      assert.equal(cov.get(zeroRow)?.coverageStatus, "unknown", `${zeroRow} was 0/0 in the export`);
      assert.deepEqual(cov.get(zeroRow)?.characters, []);
    }
    // Professions the Forever export never listed are not invented as "none" (or anything else).
    for (const absent of ["Cooking", "Fishing", "First Aid", "Jewelcrafting", "Inscription"]) {
      assert.equal(cov.has(absent), false, `${absent} was never observed for Forever`);
    }
    assert.equal(facts.professions.coverage.some((c) => c.coverageStatus === "none"), false);

    // The character's own observed entries are preserved verbatim (raw 0/0 included) - only coverage interprets them.
    const own = facts.professions.byCharacter[0];
    assert.equal(own.observationStatus, "OBSERVED");
    assert.equal(own.professions.length, 9);
    assert.deepEqual(own.professions.find((p) => p.name === "Alchemy"), { name: "Alchemy", skill: 0, maxSkill: 0 });
  } finally {
    store.close();
  }
});

test("[REAL] Forever profession coverage is scoped to the realm as well", () => {
  const store = halloStore();
  try {
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    const realmCov = facts.realms[0].professions.coverage.map((c) => [c.profession, c.coverageStatus]);
    assert.deepEqual(realmCov, facts.professions.coverage.map((c) => [c.profession, c.coverageStatus]));
  } finally {
    store.close();
  }
});

// --- Version isolation & realm isolation --------------------------------------

test("[REAL+SYNTHETIC] Forever, Classic Era, and TBC data never mix, even for an identically named character on the same realm string", () => {
  const store = halloStore();
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    store.importSnapshot(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
    // A Classic Era character deliberately sharing Hallo's name AND realm text.
    const twin = store.importSnapshot(
      buildWowSyncExport({
        character: {
          name: "Hallo Emberstone",
          realm: "Classic Beta PvP 2",
          level: 20,
          moneyCopper: 5_000_000,
          clientVersion: "1.15.9",
          clientBuild: "69547",
        },
      }),
    );
    assert.equal(twin.character.version, "classic-era");
    assert.equal(twin.character.identityKey, "classic-era::classic beta pvp 2::hallo emberstone");
    assert.notEqual(twin.character.identityKey, HALLO_KEY);

    const forever = store.buildAccountFacts("forever", NOW_RECENT);
    const era = store.buildAccountFacts("classic-era", NOW_RECENT);
    assert.equal(forever.characterCount, 1);
    assert.equal(forever.gold.totalKnownCopper, 291, "Classic Era gold never leaks into Forever");
    assert.equal(era.characterCount, 2);
    assert.equal(era.gold.totalKnownCopper, 5_000_000 + 114, "Forever gold never leaks into Classic Era (only Bromrik's first snapshot, 114c, was imported)");
    assert.deepEqual(store.buildAccountFacts("tbc-anniversary", NOW_RECENT).characters.map((c) => c.name), ["Voodan"]);

    const summaries = new Map(store.listVersions().map((v) => [v.version, v]));
    assert.equal(summaries.get("forever")?.characterCount, 1);
    assert.equal(summaries.get("forever")?.totalMoneyCopper, 291);
    assert.equal(summaries.get("classic-era")?.characterCount, 2);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] Forever realms are isolated: each realm's gold/playtime/inventory/professions stay separate", () => {
  const store = halloStore();
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: {
          name: "Zed",
          realm: "Classic Beta PvE 1",
          level: 12,
          moneyCopper: 10_000,
          playedSeconds: 5000,
          levelPlayedSeconds: 100,
          ...FOREVER,
        },
        bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2516::::::::12:1485:::::::::", name: "Light Shot", qty: 40 }] }] },
        professions: { entries: [{ name: "Herbalism", skill: 15, maxSkill: 75 }] },
      }),
    );

    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.equal(facts.aggregationScope, "realm");
    assert.deepEqual(facts.realms.map((r) => r.realm), ["Classic Beta PvE 1", "Classic Beta PvP 2"]);
    const [pve, pvp] = facts.realms;

    assert.equal(pve.gold.totalKnownCopper, 10_000);
    assert.equal(pvp.gold.totalKnownCopper, 291);
    assert.equal(pve.playtime.totalKnownPlayedSeconds, 5000);
    assert.equal(pvp.playtime.charactersWithKnownPlaytime, 0);

    assert.equal(pve.inventory.items.find((i) => i.name === "Light Shot")?.totalKnownQty, 40);
    assert.equal(pvp.inventory.items.find((i) => i.name === "Light Shot")?.totalKnownQty, 587);

    const pveHerb = pve.professions.coverage.find((c) => c.profession === "Herbalism");
    const pvpHerb = pvp.professions.coverage.find((c) => c.profession === "Herbalism");
    assert.equal(pveHerb?.coverageStatus, "covered");
    assert.equal(pvpHerb?.coverageStatus, "unknown", "Hallo's Herbalism is 0/0 - Zed's realm must not turn it 'covered'");
    assert.deepEqual(pve.characters.map((c) => c.name), ["Zed"]);
    assert.deepEqual(pvp.characters.map((c) => c.name), ["Hallo Emberstone"]);
  } finally {
    store.close();
  }
});

// --- AccountContext / LlmContext ---------------------------------------------

test("[REAL] AccountContext carries a forever version alongside the others, embedding the same AccountFacts wholesale", () => {
  const store = halloStore();
  try {
    const ctx = store.buildAccountContext(NOW_RECENT);
    assert.deepEqual(Object.keys(ctx.versions), ["classic-era", "tbc-anniversary", "retail", "forever"]);
    const fv = ctx.versions["forever"];
    assert.equal(fv.version, "forever");
    assert.equal(fv.aggregationScope, "realm");
    assert.deepEqual(fv.facts, store.buildAccountFacts("forever", NOW_RECENT));

    assert.equal(fv.characters.length, 1);
    const hallo = fv.characters[0];
    assert.equal(hallo.identityKey, HALLO_KEY);
    assert.equal(hallo.snapshotHistory.length, 2);
    assert.deepEqual(hallo.snapshotHistory.map((h) => h.level), [4, 7], "chronological, oldest first");
    assert.equal(hallo.transitions.length, 1);
    assert.equal(hallo.transitions[0].levelChanged, true);
    assert.equal(hallo.transitions[0].goldDeltaCopper, 236);
    assert.equal(hallo.transitions[0].inventoryChanged, false);
    // Trainer view reuses the existing summarizer; Forever has observed no trainer categories.
    assert.deepEqual(hallo.trainer, []);
    assert.equal(ctx.schemaVersion, "2");
    assert.ok(ctx.currency.note.includes("Copper"));
  } finally {
    store.close();
  }
});

test("[REAL] AccountContext is deterministic with Forever included", () => {
  const store = halloStore();
  try {
    assert.equal(JSON.stringify(store.buildAccountContext(NOW_RECENT)), JSON.stringify(store.buildAccountContext(NOW_RECENT)));
  } finally {
    store.close();
  }
});

test("[REAL] LlmContext (Ask My Account's payload) projects Forever with raw + formatted copper and honest UNKNOWNs", () => {
  const store = halloStore();
  try {
    const llm = buildLlmContext(store.buildAccountContext(NOW_RECENT));
    const fv = llm.versions["forever"];
    assert.equal(fv.version, "forever");
    assert.equal(fv.aggregationScope, "realm");
    assert.equal(fv.goldSummary.totalKnownCopper, 291);
    assert.equal(fv.goldSummary.totalKnownFormatted, formatCopper(291));
    assert.equal(fv.goldSummary.totalKnownFormatted, "2s 91c");

    const hallo = fv.characters[0];
    assert.equal(hallo.goldCopper, 291);
    assert.equal(hallo.goldFormatted, "2s 91c");
    assert.equal(hallo.playedSeconds, undefined);
    assert.equal(hallo.bankStatus, "UNKNOWN");
    assert.equal(hallo.comparisonStatus, "AVAILABLE");
    assert.equal(hallo.latestTransition?.goldDeltaCopper, 236);
    assert.equal(hallo.latestTransition?.previousGoldCopper, 55);
    assert.equal(hallo.latestTransition?.currentGoldCopper, 291);
    assert.equal(hallo.latestTransition?.playtimeDeltaSeconds, undefined);
    assert.equal(hallo.latestTransition?.inventory, undefined, "bags went UNKNOWN -> OBSERVED: no fabricated inventory delta");
    assert.deepEqual(llm.latestTransitionIndex.goldChanged, [HALLO_KEY]);
    assert.deepEqual(llm.latestTransitionIndex.levelChanged, [HALLO_KEY]);
    assert.deepEqual(llm.latestTransitionIndex.inventoryChanged, []);
    assert.deepEqual(llm.latestTransitionIndex.playtimeChanged, []);
    // Pure projection: the input context is unchanged by it.
    const ctx = store.buildAccountContext(NOW_RECENT);
    const before = JSON.stringify(ctx);
    buildLlmContext(ctx);
    assert.equal(JSON.stringify(ctx), before);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] with no Forever data at all, AccountContext/LlmContext still carry an empty forever version (present, not absent)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    const ctx = store.buildAccountContext(NOW_RECENT);
    assert.equal(ctx.versions["forever"].characters.length, 0);
    assert.deepEqual(ctx.versions["forever"].facts.realms, []);
    const llm = buildLlmContext(ctx);
    assert.deepEqual(llm.versions["forever"].characters, []);
    assert.deepEqual(llm.versions["forever"].goldSummary, {}, "no known gold -> no total, never '0c'");
    // buildAccountContext (pure) stays independent of the store.
    assert.equal(typeof buildAccountContext, "function");
  } finally {
    store.close();
  }
});

// --- Malformed / partial Forever exports -----------------------------------------

test("[SYNTHETIC] a Forever export missing its Interface line still imports as Forever", () => {
  const text = buildWowSyncExport({ character: { name: "Nointerface", realm: "Classic Beta PvP 2", ...FOREVER, interface: undefined } });
  const parsed = parseWowSyncExport(text);
  assert.equal(detectVersion(parsed.character), "forever");
  assert.equal(parsed.character.interface, undefined, "unknown stays undefined, not a guessed default");
});

test("[SYNTHETIC] a Forever export with every optional section UNKNOWN imports cleanly and leaves everything UNKNOWN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Sparse", realm: "Classic Beta PvP 2", level: 1, ...FOREVER },
        location: { unknown: true },
        equipment: { unknown: true },
        bags: { unknown: true },
        bank: { unknown: true },
        professions: { unknown: true },
        spells: { unknown: true },
        trainer: { unknown: true },
      }),
    );
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    const c = facts.characters[0];
    assert.equal(c.goldCopper, undefined);
    assert.equal(c.bankStatus, "UNKNOWN");
    assert.equal(facts.gold.charactersWithUnknownGold, 1);
    assert.equal(facts.gold.totalKnownCopper, 0);
    assert.equal(facts.inventory.hasUnknownStorage, true);
    assert.deepEqual(facts.professions.coverage, []);
    assert.equal(facts.professions.byCharacter[0].observationStatus, "UNKNOWN");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a Forever export whose professions section is OBSERVED but empty is 'no professions', and coverage stays empty (never 'none' for an uncatalogued version)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Bare", realm: "Classic Beta PvP 2", ...FOREVER },
        professions: { entries: [] },
      }),
    );
    const facts = store.buildAccountFacts("forever", NOW_RECENT);
    assert.equal(facts.professions.byCharacter[0].observationStatus, "OBSERVED");
    assert.deepEqual(facts.professions.byCharacter[0].professions, []);
    assert.deepEqual(facts.professions.coverage, []);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] truncated or garbage Forever input is rejected with a parse error and stores nothing", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const good = read(LEVEL7);
    const truncated = good.slice(0, good.indexOf("[BAGS]"));
    assert.throws(() => store.importSnapshot(truncated), WowSyncParseError);
    assert.throws(() => store.importSnapshot("ClientFamily: Forever"), WowSyncParseError);
    assert.throws(() => store.importSnapshot(good.replace(/^Client: .*\n/m, "")), WowSyncParseError);
    assert.deepEqual(store.listCharacters("forever"), []);
    assert.equal(store.listVersions().length, 0);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] existing Retail/Classic/TBC data is unaffected by Forever profession semantics (0/0 there still counts as covered)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Oldtimer", realm: "Dreamscythe", clientVersion: "2.5.6", clientBuild: "69795" },
        professions: { entries: [{ name: "Alchemy", skill: 0, maxSkill: 0 }] },
      }),
    );
    const alchemy = store
      .buildAccountFacts("tbc-anniversary", NOW_RECENT)
      .professions.coverage.find((c) => c.profession === "Alchemy");
    assert.equal(alchemy?.coverageStatus, "covered");
  } finally {
    store.close();
  }
});

// --- LlmContext profession honesty ------------------------------------------------

test("[REAL] LlmContext flags Forever's 0/0 profession rows as indeterminate and leaves real skills unflagged", () => {
  const store = halloStore();
  try {
    const hallo = buildLlmContext(store.buildAccountContext(NOW_RECENT)).versions["forever"].characters[0];
    assert.equal(hallo.professionsObservationStatus, "OBSERVED");
    const byName = new Map(hallo.professions.map((p) => [p.name, p]));
    assert.deepEqual(byName.get("Engineering"), { name: "Engineering", skill: 20, maxSkill: 75 });
    assert.deepEqual(byName.get("Mining"), { name: "Mining", skill: 22, maxSkill: 75 });
    assert.deepEqual(byName.get("Alchemy"), { name: "Alchemy", skill: 0, maxSkill: 0, indeterminate: true });
    assert.equal(hallo.professions.filter((p) => p.indeterminate).length, 7);
  } finally {
    store.close();
  }
});

test("[REAL] LlmContext distinguishes a never-observed professions section (UNKNOWN) from an empty one", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read(LEVEL4));
    const hallo = buildLlmContext(store.buildAccountContext(NOW_RECENT)).versions["forever"].characters[0];
    assert.equal(hallo.professionsObservationStatus, "UNKNOWN");
    assert.deepEqual(hallo.professions, [], "empty list here means never observed, not 'no professions'");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] LlmContext never flags non-Forever professions as indeterminate, even at 0/0", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Oldtimer", realm: "Dreamscythe", clientVersion: "2.5.6", clientBuild: "69795" },
        professions: { entries: [{ name: "Alchemy", skill: 0, maxSkill: 0 }] },
      }),
    );
    const c = buildLlmContext(store.buildAccountContext(NOW_RECENT)).versions["tbc-anniversary"].characters[0];
    assert.deepEqual(c.professions, [{ name: "Alchemy", skill: 0, maxSkill: 0 }]);
    assert.equal("indeterminate" in c.professions[0], false);
  } finally {
    store.close();
  }
});
