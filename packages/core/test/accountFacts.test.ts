// Tests the deterministic AccountFacts layer. Primary validation is
// against real fixtures (Bromrik/Ezaller/Voodan); synthetic exports are
// used only for edge cases real data doesn't happen to demonstrate
// (unknown gold, unknown professions, unknown bank, insufficient history).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { searchInventory } from "../src/accountFacts.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

const FIXED_NOW = 1_800_000_000; // arbitrary but fixed reference time, well after every real fixture's timestamps

function seededStore() {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
  store.importSnapshot(read("classic-era/bromrik-1789171621.wowsync.txt"));
  store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
  store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
  return store;
}

// --- 1. Account overview: version isolation, character count ---

test("[REAL] AccountFacts never aggregates across WoW versions", () => {
  const store = seededStore();
  try {
    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    const retail = store.buildAccountFacts("retail", FIXED_NOW);
    const tbc = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);

    assert.equal(era.characterCount, 1);
    assert.equal(era.characters[0].name, "Bromrik");
    assert.equal(retail.characterCount, 1);
    assert.equal(retail.characters[0].name, "Ezaller");
    assert.equal(tbc.characterCount, 1);
    assert.equal(tbc.characters[0].name, "Voodan");

    // Gold/playtime totals must never leak across versions.
    assert.equal(era.gold.totalKnownCopper, 304);
    assert.equal(retail.gold.totalKnownCopper, 24_797_508);
    assert.notEqual(era.gold.totalKnownCopper, retail.gold.totalKnownCopper + era.gold.totalKnownCopper);
  } finally {
    store.close();
  }
});

// --- Latest character state ---

test("[REAL] character facts reflect the most recent snapshot, not the first", () => {
  const store = seededStore();
  try {
    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    const bromrik = era.characters[0];
    assert.equal(bromrik.level, 4); // second/latest snapshot, not the first (level 3)
    assert.equal(bromrik.goldCopper, 304);
    assert.equal(bromrik.snapshotCount, 2);
  } finally {
    store.close();
  }
});

// --- 2. Gold: per-character totals, version totals, deltas, UNKNOWN handling ---

test("[REAL] gold totals and deltas are exact", () => {
  const store = seededStore();
  try {
    const retail = store.buildAccountFacts("retail", FIXED_NOW);
    assert.equal(retail.gold.totalKnownCopper, 24_797_508);
    assert.equal(retail.gold.charactersWithKnownGold, 1);
    assert.equal(retail.gold.charactersWithUnknownGold, 0);
    assert.equal(retail.gold.byCharacter[0].deltaCopper, 592_200);
    assert.equal(retail.gold.largestRecentChanges[0].deltaCopper, 592_200);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a character with unknown gold is never counted as zero", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({ character: { name: "Ghost", realm: "Testrealm", moneyCopper: undefined } });
    store.importSnapshot(raw);
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(facts.gold.charactersWithKnownGold, 0);
    assert.equal(facts.gold.charactersWithUnknownGold, 1);
    assert.equal(facts.gold.totalKnownCopper, 0); // sum of zero KNOWN values, not "assumed zero for the unknown character"
    assert.equal(facts.gold.byCharacter[0].goldCopper, undefined);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] version gold totals stay independent even with multiple characters per version", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "A", realm: "R", clientVersion: "2.5.6", moneyCopper: 1000 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "B", realm: "R", clientVersion: "2.5.6", moneyCopper: 2000 } }));
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(facts.gold.totalKnownCopper, 3000);
    assert.equal(facts.characterCount, 2);
  } finally {
    store.close();
  }
});

// --- 3. Playtime: total, per-character, deltas ---

test("[REAL] playtime totals and deltas are exact", () => {
  const store = seededStore();
  try {
    const retail = store.buildAccountFacts("retail", FIXED_NOW);
    assert.equal(retail.playtime.totalKnownPlayedSeconds, 12_638);
    assert.equal(retail.playtime.charactersWithKnownPlaytime, 1);
    assert.equal(retail.playtime.byCharacter[0].deltaPlayedSeconds, 65);
    assert.equal(retail.playtime.byCharacter[0].deltaLevelPlayedSeconds, 65);
  } finally {
    store.close();
  }
});

test("[REAL] a character whose addon build never emitted PlayedSeconds is excluded from the known playtime total", () => {
  const store = seededStore();
  try {
    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(era.playtime.charactersWithKnownPlaytime, 0);
    assert.equal(era.playtime.totalKnownPlayedSeconds, 0);
    assert.equal(era.playtime.byCharacter[0].playedSeconds, undefined);
  } finally {
    store.close();
  }
});

// --- 4. Progression: level changes, XP changes, XP progress, insufficient-history handling ---

test("[REAL] level and XP progression are exact, including percent-to-next-level", () => {
  const store = seededStore();
  try {
    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    const bromrik = era.progression.byCharacter[0];
    assert.equal(bromrik.levelDeltaSincePrevious, 1);
    assert.equal(era.progression.recentLevelUps.length, 1);
    assert.equal(era.progression.recentLevelUps[0].fromLevel, 3);
    assert.equal(era.progression.recentLevelUps[0].toLevel, 4);

    const retail = store.buildAccountFacts("retail", FIXED_NOW);
    const ezaller = retail.progression.byCharacter[0];
    assert.equal(Math.round((ezaller.xpPercent ?? 0) * 100) / 100, Math.round((55642 / 72820) * 100 * 100) / 100);
    assert.equal(retail.progression.closestToNextLevel?.name, "Ezaller");
  } finally {
    store.close();
  }
});

test("[REAL] a character with only one snapshot has no level delta - never estimated", () => {
  const store = seededStore();
  try {
    const tbc = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(tbc.characters[0].snapshotCount, 1);
    assert.equal(tbc.progression.byCharacter[0].levelDeltaSincePrevious, undefined);
    assert.equal(tbc.progression.recentLevelUps.length, 0);
  } finally {
    store.close();
  }
});

// --- 5. Professions: per-character, account aggregation, unknown handling ---

test("[REAL] professions are reported per character and aggregated by profession name across the account", () => {
  const store = seededStore();
  try {
    const tbc = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const voodan = tbc.professions.byCharacter[0];
    assert.equal(voodan.status, "OBSERVED");
    assert.ok(voodan.professions.some((p) => p.name === "Tailoring" && p.skill === 54));

    const tailoringCoverage = tbc.professions.coverage.find((c) => c.profession === "Tailoring");
    assert.equal(tailoringCoverage?.characters[0].name, "Voodan");
    assert.equal(tailoringCoverage?.characters[0].skill, 54);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a character whose professions were never observed is UNKNOWN, not 'no professions'", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({ character: { name: "Ghost", realm: "R" }, professions: { unknown: true } });
    store.importSnapshot(raw);
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(facts.professions.byCharacter[0].status, "UNKNOWN");
    assert.equal(facts.professions.byCharacter[0].professions.length, 0);
    assert.equal(facts.professions.coverage.length, 0);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] an observed-but-empty professions section is distinct from UNKNOWN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({ character: { name: "Ghost", realm: "R" }, professions: { entries: [] } });
    store.importSnapshot(raw);
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(facts.professions.byCharacter[0].status, "OBSERVED");
    assert.equal(facts.professions.byCharacter[0].professions.length, 0);
  } finally {
    store.close();
  }
});

// --- 6. Inventory: item aggregation, character separation, version separation, base item identity, unknown bank handling ---

test("[SYNTHETIC] inventory aggregates the same item across characters by base item ID, not the full (level-linked) itemRef", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Alpha", realm: "R", clientVersion: "2.5.6", level: 10 },
        bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:2589::::::::10:::::", name: "Linen Cloth", qty: 5 }] }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Beta", realm: "R", clientVersion: "2.5.6", level: 20 },
        bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:2589::::::::20:::::", name: "Linen Cloth", qty: 3 }] }] },
      }),
    );
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(facts.inventory.items.length, 1); // one item, not two despite differing itemRef level components
    const linen = facts.inventory.items[0];
    assert.equal(linen.totalKnownQty, 8);
    assert.equal(linen.locations.length, 2);
    const names = linen.locations.map((l) => l.name).sort();
    assert.deepEqual(names, ["Alpha", "Beta"]);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] inventory never aggregates across WoW versions", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "EraChar", realm: "R", clientVersion: "1.15.7" },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 5 }] }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "TbcChar", realm: "R", clientVersion: "2.5.6" },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 7 }] }] },
      }),
    );
    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    const tbc = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(era.inventory.items[0].totalKnownQty, 5);
    assert.equal(tbc.inventory.items[0].totalKnownQty, 7);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a character's unknown bank never contributes items, and never gets counted as an empty bank", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({
      character: { name: "Ghost", realm: "R" },
      bank: { unknown: true },
      bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:1", name: "Known Item", qty: 1 }] }] },
    });
    store.importSnapshot(raw);
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(facts.inventory.unknownBank.length, 1);
    assert.equal(facts.inventory.unknownBank[0].name, "Ghost");
    assert.equal(facts.inventory.hasUnknownStorage, true);
    // The known bag item still shows up - only the unknown bank is excluded.
    assert.equal(facts.inventory.items.length, 1);
    assert.equal(facts.inventory.items[0].name, "Known Item");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] item search finds items by case-insensitive substring", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Alpha", realm: "R" },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:2589", name: "Strange Dust", qty: 12 }] }] },
      }),
    );
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    const found = searchInventory(facts.inventory, "strange");
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Strange Dust");
  } finally {
    store.close();
  }
});

// --- 7. Freshness: recent, stale, unknown (integration) ---

test("[SYNTHETIC] freshness is classified against the character's latest observation timestamp", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: FIXED_NOW - 3600, character: { name: "Recent", realm: "R" } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: FIXED_NOW - 30 * 24 * 3600, character: { name: "Stale", realm: "R" } }));
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    const byName = new Map(facts.freshness.byCharacter.map((c) => [c.name, c.freshness]));
    assert.equal(byName.get("Recent"), "recent");
    assert.equal(byName.get("Stale"), "stale");
    assert.equal(facts.freshness.recentCharacters, 1);
    assert.equal(facts.freshness.staleCharacters, 1);
  } finally {
    store.close();
  }
});

// --- 8. AccountFacts: deterministic output ---

test("AccountFacts is deterministic - same DB state and `now` produce identical output", () => {
  const store = seededStore();
  try {
    const a = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const b = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.deepEqual(a, b);
  } finally {
    store.close();
  }
});

test("recentChanges (and therefore AccountFacts.recentChanges) now also surfaces trainer/location-only changes", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const before = buildWowSyncExport({
      character: { name: "Wanderer", realm: "R" },
      location: { zone: "Zone A" },
    });
    const after = buildWowSyncExport({
      character: { name: "Wanderer", realm: "R" },
      location: { zone: "Zone B" },
    });
    store.importSnapshot(before);
    store.importSnapshot(after);
    const facts = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(facts.recentChanges.length, 1);
    assert.equal(facts.recentChanges[0].locationChanged, true);
  } finally {
    store.close();
  }
});
