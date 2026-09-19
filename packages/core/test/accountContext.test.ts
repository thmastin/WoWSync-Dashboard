// AccountContext: the "Export Dashboard Context" developer tool's
// canonical export. This module is a thin assembly layer over AccountFacts
// (embedded wholesale) plus per-character history/trainer detail built by
// reusing diffSnapshots and summarizeTrainerCategory - so most of these
// tests check that the assembly is correct (ordering, embedding fidelity,
// determinism) rather than re-testing AccountFacts' own rules (those live
// in accountFacts.test.ts / realmFacts.test.ts already).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const FIXED_NOW = 1_800_000_000;

function seededRealStore() {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
  store.importSnapshot(read("classic-era/bromrik-1789171621.wowsync.txt"));
  store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
  store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));
  store.importSnapshot(read("retail/stoneharry-1789486499.wowsync.txt"));
  store.importSnapshot(read("retail/stoneharry-1789491879.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/voodan-1789492666.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/torahn-1789492498.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/tenivard-1789492580.wowsync.txt"));
  return store;
}

// --- 1, 2. All three versions present; version isolation ---

test("[REAL] AccountContext includes exactly the four known WoW versions, each correctly populated", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    assert.equal(ctx.schemaVersion, "2");
    assert.equal(ctx.generatedAt, FIXED_NOW);
    assert.equal(ctx.currency.unit, "copper");
    assert.match(ctx.currency.note, /never gold/);
    assert.deepEqual(Object.keys(ctx.versions).sort(), ["classic-era", "forever", "retail", "tbc-anniversary"]);
    // The real seed data has no Forever character: the version is present but empty, never absent.
    assert.equal(ctx.versions["forever"].characters.length, 0);
    assert.equal(ctx.versions["forever"].facts.characterCount, 0);

    assert.equal(ctx.versions["classic-era"].characters.length, 1);
    assert.equal(ctx.versions["classic-era"].characters[0].name, "Bromrik");
    assert.equal(ctx.versions["tbc-anniversary"].characters.length, 3);
    assert.equal(ctx.versions["retail"].characters.length, 2);

    // No character from one version leaks into another.
    const allNames = (v: keyof typeof ctx.versions) => ctx.versions[v].characters.map((c) => c.name).sort();
    assert.deepEqual(allNames("classic-era"), ["Bromrik"]);
    assert.deepEqual(allNames("tbc-anniversary"), ["Tenivard", "Torahn", "Voodan"]);
    assert.deepEqual(allNames("retail"), ["Ezaller", "Stoneharry"]);
  } finally {
    store.close();
  }
});

// --- 3, 4. Retail account-wide vs Classic/TBC realm scope ---

test("[REAL] Retail's embedded AccountFacts stays account-wide; Classic/TBC stay realm-scoped", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    assert.equal(ctx.versions.retail.aggregationScope, "account-wide");
    assert.equal(ctx.versions.retail.facts.realms.length, 0);
    // Real proof: Ezaller (Kel'Thuzad) and Stoneharry (Thrall) are on
    // different realms, and Retail's total still combines them.
    assert.equal(
      ctx.versions.retail.facts.gold.totalKnownCopper,
      ctx.versions.retail.facts.gold.byCharacter.reduce((sum, g) => sum + (g.goldCopper ?? 0), 0),
    );

    assert.equal(ctx.versions["classic-era"].aggregationScope, "realm");
    assert.equal(ctx.versions["classic-era"].facts.realms.length, 1);
    assert.equal(ctx.versions["classic-era"].facts.realms[0].realm, "Defias Pillager");

    assert.equal(ctx.versions["tbc-anniversary"].aggregationScope, "realm");
    assert.equal(ctx.versions["tbc-anniversary"].facts.realms[0].realm, "Dreamscythe");
  } finally {
    store.close();
  }
});

// --- 5. Multiple characters ---

test("[REAL] multiple characters within one scope are all represented with their own history", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const tbc = ctx.versions["tbc-anniversary"].characters;
    const byName = new Map(tbc.map((c) => [c.name, c]));
    assert.equal(byName.get("Voodan")?.snapshotHistory.length, 2);
    assert.equal(byName.get("Torahn")?.snapshotHistory.length, 1);
    assert.equal(byName.get("Tenivard")?.snapshotHistory.length, 1);
  } finally {
    store.close();
  }
});

// --- 6, 7. UNKNOWN gold / UNKNOWN bank preserved (via embedded AccountFacts) ---

test("[SYNTHETIC] unknown gold and unknown bank are preserved through the export, never zeroed", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Ghost", realm: "R", moneyCopper: undefined }, bank: { unknown: true } }),
    );
    const ctx = store.buildAccountContext(FIXED_NOW);
    const era = ctx.versions["classic-era"];
    assert.equal(era.facts.gold.charactersWithUnknownGold, 1);
    assert.equal(era.facts.gold.byCharacter[0].goldCopper, undefined);
    assert.equal(era.facts.inventory.unknownBank[0]?.name, "Ghost");
    assert.equal(era.facts.inventory.hasUnknownStorage, true);
  } finally {
    store.close();
  }
});

// --- 8, 9. NONE vs UNKNOWN professions; profession coverage ---

test("[REAL] profession coverage (covered/none) is preserved exactly as AccountFacts computed it", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const coverage = ctx.versions["tbc-anniversary"].facts.realms[0].professions.coverage;
    const byName = new Map(coverage.map((c) => [c.profession, c]));
    assert.equal(byName.get("Tailoring")?.coverageStatus, "covered");
    assert.equal(byName.get("Alchemy")?.coverageStatus, "none");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a profession is 'unknown' in the export when a character's professions were never observed", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "R" }, professions: { unknown: true } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    const coverage = ctx.versions["classic-era"].facts.realms[0].professions.coverage;
    assert.ok(coverage.length > 0);
    assert.ok(coverage.every((c) => c.coverageStatus === "unknown"));
  } finally {
    store.close();
  }
});

// --- 10. Snapshot history ---

test("[REAL] Bromrik's snapshot history is chronological (oldest first) and matches the real observed values", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const bromrik = ctx.versions["classic-era"].characters[0];
    assert.equal(bromrik.snapshotHistory.length, 2);
    assert.equal(bromrik.snapshotHistory[0].level, 3);
    assert.equal(bromrik.snapshotHistory[0].moneyCopper, 114);
    assert.equal(bromrik.snapshotHistory[1].level, 4);
    assert.equal(bromrik.snapshotHistory[1].moneyCopper, 304);
    assert.ok(bromrik.snapshotHistory[0].generatedAt! < bromrik.snapshotHistory[1].generatedAt!);
  } finally {
    store.close();
  }
});

// --- 11. Recent changes (top-level, from embedded AccountFacts) + per-character transitions ---

test("[REAL] Voodan's post-AH transition matches the real observed gold/playtime/inventory facts, with no inferred label", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const voodan = ctx.versions["tbc-anniversary"].characters.find((c) => c.name === "Voodan")!;
    assert.equal(voodan.transitions.length, 1);
    const t = voodan.transitions[0];
    assert.equal(t.goldDeltaCopper, 1_101_858 - 1_065_796);
    assert.equal(t.playtimeDeltaSeconds, 114_630 - 114_517);
    assert.equal(t.inventoryChanged, true);
    assert.equal(t.levelChanged, false);
    assert.equal(t.professionChanged, false);
    // Compact item-level inventory transition data (the concrete gap an LLM
    // evaluation pass found missing: without this, "what changed in your
    // bags" was unanswerable from the context even though the diff engine
    // computes it). Verified against the real bags sections of
    // voodan-1789484723 and voodan-1789492666 byte-for-byte: two items
    // dropped to zero, three appeared, everything else held steady.
    assert.deepEqual(t.inventoryItemChanges, [
      { storage: "bags", itemKey: "3685", name: "Raptor Egg", deltaQty: 18 },
      { storage: "bags", itemKey: "3737", name: "Recipe: Soothing Turtle Bisque", deltaQty: 1 },
      { storage: "bags", itemKey: "15127", name: "Robust Shoulders of Intellect", deltaQty: 1 },
      { storage: "bags", itemKey: "828", name: "Small Blue Pouch", deltaQty: -1 },
      { storage: "bags", itemKey: "5082", name: "Thin Kodo Leather", deltaQty: -1 },
    ]);
    // Compact means compact: no raw fromQty/toQty/full-itemRef bloat leaks in.
    for (const change of t.inventoryItemChanges!) {
      assert.equal(Object.keys(change).sort().join(","), "deltaQty,itemKey,name,storage");
    }
    // itemKey uses the same base-item-ID convention as InventoryFacts.items,
    // so a consumer can cross-reference a transition against current totals.
    const raptorEggTotal = ctx.versions["tbc-anniversary"].facts.inventory.items.find((i) => i.itemKey === "3685");
    assert.equal(raptorEggTotal?.name, "Raptor Egg");
    // Also present in the version-wide recentChanges (embedded facts) - same
    // diffToChangeSummary mapping, so the item-level detail flows there too.
    const recentVoodan = ctx.versions["tbc-anniversary"].facts.recentChanges.find((c) => c.characterName === "Voodan");
    assert.ok(recentVoodan);
    assert.equal(recentVoodan!.inventoryItemChanges?.length, 5);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] a transition with no inventory change has inventoryItemChanges omitted, never an empty array", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_000, character: { name: "Wanderer", realm: "R", moneyCopper: 100 } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_600, character: { name: "Wanderer", realm: "R", moneyCopper: 250 } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    const wanderer = ctx.versions["classic-era"].characters.find((c) => c.name === "Wanderer")!;
    assert.equal(wanderer.transitions.length, 1);
    const t = wanderer.transitions[0];
    assert.equal(t.goldDeltaCopper, 150);
    assert.equal(t.inventoryChanged, false);
    assert.equal(t.inventoryItemChanges, undefined);
  } finally {
    store.close();
  }
});

// --- Chronology tie-breaking when snapshots share generatedAt ---
//
// snapshotSortKey() only orders by generatedAt (falling back to
// importedAt when generatedAt is absent). When two snapshots share an
// identical generatedAt, Array.prototype.sort's stability preserves
// their relative order from the *input* array - which is
// listSnapshots()'s newest-first order, not oldest-first. That silently
// builds the transition as diffSnapshots(newer, older) instead of
// diffSnapshots(older, newer), reversing every directional delta.

test("[SYNTHETIC] snapshots with identical generatedAt still produce an oldest-to-newest transition, never reversed", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const tiedGeneratedAt = 1_700_000_000;
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: tiedGeneratedAt,
        character: { name: "Chrono", realm: "R", moneyCopper: 100 },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 2 }] }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: tiedGeneratedAt,
        character: { name: "Chrono", realm: "R", moneyCopper: 300 },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 9 }] }] },
      }),
    );
    const ctx = store.buildAccountContext(FIXED_NOW);
    const chrono = ctx.versions["classic-era"].characters.find((c) => c.name === "Chrono")!;

    assert.equal(chrono.snapshotHistory.length, 2);
    assert.equal(chrono.snapshotHistory[0].moneyCopper, 100);
    assert.equal(chrono.snapshotHistory[1].moneyCopper, 300);

    assert.equal(chrono.transitions.length, 1);
    const t = chrono.transitions[0];
    // Gold went 100 -> 300: must be a +200 gain, never -200.
    assert.equal(t.goldDeltaCopper, 200);
    // Linen Cloth went 2 -> 9: must be a +7 gain, never -7.
    assert.equal(t.inventoryItemChanges?.length, 1);
    assert.equal(t.inventoryItemChanges?.[0].deltaQty, 7);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] three snapshots sharing the same generatedAt still order oldest-to-newest, transitively", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const tiedGeneratedAt = 1_700_000_000;
    for (const money of [100, 200, 300]) {
      store.importSnapshot(buildWowSyncExport({ generatedAt: tiedGeneratedAt, character: { name: "Trio", realm: "R", moneyCopper: money } }));
    }
    const ctx = store.buildAccountContext(FIXED_NOW);
    const trio = ctx.versions["classic-era"].characters.find((c) => c.name === "Trio")!;

    assert.deepEqual(
      trio.snapshotHistory.map((h) => h.moneyCopper),
      [100, 200, 300],
    );
    assert.deepEqual(
      trio.transitions.map((t) => t.goldDeltaCopper),
      [100, 100],
    );
  } finally {
    store.close();
  }
});

test("[REAL] a character with only one snapshot has no transitions - never fabricated", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const torahn = ctx.versions["tbc-anniversary"].characters.find((c) => c.name === "Torahn")!;
    assert.deepEqual(torahn.transitions, []);
  } finally {
    store.close();
  }
});

// --- 12. Trainer summary (grouped, not raw) ---

test("[REAL] Voodan's trainer export embeds the grouped summary, not the 180 raw services", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const voodan = ctx.versions["tbc-anniversary"].characters.find((c) => c.name === "Voodan")!;
    const cls = voodan.trainer.find((t) => t.category === "CLASS")!;
    assert.equal(cls.status, "LAST_SEEN");
    assert.equal(cls.name, "Malakai Cross");
    assert.equal(cls.summary.nextTraining?.requiredLevel, 18);
    assert.equal(cls.summary.upcomingByLevel.length, 32);
    // The raw per-service array must not appear anywhere on the context object.
    assert.equal((cls.summary as unknown as { services?: unknown }).services, undefined);
  } finally {
    store.close();
  }
});

test("[REAL] a character whose trainer was never visited has an empty trainer array, not an error", () => {
  const store = seededRealStore();
  try {
    const ctx = store.buildAccountContext(FIXED_NOW);
    const bromrik = ctx.versions["classic-era"].characters[0];
    assert.deepEqual(bromrik.trainer, []);
  } finally {
    store.close();
  }
});

// --- 13. Freshness (from embedded AccountFacts) ---

test("[SYNTHETIC] freshness classification in the export matches the existing freshness layer", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: FIXED_NOW - 3600, character: { name: "Fresh", realm: "R" } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: FIXED_NOW - 30 * 24 * 3600, character: { name: "Old", realm: "R" } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    const byName = new Map(ctx.versions["classic-era"].facts.freshness.byCharacter.map((c) => [c.name, c.freshness]));
    assert.equal(byName.get("Fresh"), "recent");
    assert.equal(byName.get("Old"), "stale");
  } finally {
    store.close();
  }
});

// --- 14. Deterministic output ---

test("AccountContext is byte-for-byte deterministic given the same DB state and the same explicit now", () => {
  const store = seededRealStore();
  try {
    const a = JSON.stringify(store.buildAccountContext(FIXED_NOW));
    const b = JSON.stringify(store.buildAccountContext(FIXED_NOW));
    assert.equal(a, b);
  } finally {
    store.close();
  }
});

test("changing an observed value changes the corresponding export output", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Changer", realm: "R", moneyCopper: 100 } }));
    const before = JSON.stringify(store.buildAccountContext(FIXED_NOW));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Changer", realm: "R", moneyCopper: 500 } }));
    const after = JSON.stringify(store.buildAccountContext(FIXED_NOW));
    assert.notEqual(before, after);
  } finally {
    store.close();
  }
});

// --- 15. Malformed/partial data ---

test("[SYNTHETIC] a character with entirely unobserved sections still produces a valid, non-throwing export", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Blank", realm: "R", moneyCopper: undefined, playedSeconds: undefined },
        bank: { unknown: true },
        bags: { unknown: true },
        professions: { unknown: true },
        trainer: { unknown: true },
      }),
    );
    const ctx = store.buildAccountContext(FIXED_NOW);
    const c = ctx.versions["classic-era"].characters[0];
    assert.equal(c.name, "Blank");
    assert.deepEqual(c.trainer, []);
    assert.equal(c.snapshotHistory[0].moneyCopper, undefined);
  } finally {
    store.close();
  }
});
