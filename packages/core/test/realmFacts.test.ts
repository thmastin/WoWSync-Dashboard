// Realm-aware AccountFacts: Classic Era and TBC Anniversary have no
// cross-realm economy, so gold/playtime/professions/inventory must be
// partitioned by realm (never silently combined); Retail keeps its
// account-wide aggregation. Primary validation is against the real
// Dreamscythe roster (Torahn/Voodan/Tenivard) and real Ezaller/Stoneharry
// (two different Retail realms, which is itself a great real test of
// "Retail combines across realms, Classic/TBC does not"). Synthetic
// fixtures cover the one thing the current real data can't demonstrate:
// a SECOND Classic/TBC realm, to prove isolation rather than just
// single-realm pass-through.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const FIXED_NOW = 1_800_000_000;

function seededDreamscytheStore() {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/voodan-1789492666.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/torahn-1789492498.wowsync.txt"));
  store.importSnapshot(read("tbc-anniversary/tenivard-1789492580.wowsync.txt"));
  return store;
}

// --- Real single-realm TBC roster ---

test("[REAL] TBC Anniversary is realm-partitioned; Dreamscythe holds all three real characters", () => {
  const store = seededDreamscytheStore();
  try {
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(facts.aggregationScope, "realm");
    assert.equal(facts.realms.length, 1);
    assert.equal(facts.realms[0].realm, "Dreamscythe");
    assert.equal(facts.realms[0].characterCount, 3);
    const names = facts.realms[0].characters.map((c) => c.name).sort();
    assert.deepEqual(names, ["Tenivard", "Torahn", "Voodan"]);
  } finally {
    store.close();
  }
});

test("[REAL] Dreamscythe realm gold total matches the sum of its three characters' latest gold", () => {
  const store = seededDreamscytheStore();
  try {
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const dreamscythe = facts.realms[0];
    assert.equal(dreamscythe.gold.totalKnownCopper, 1_101_858 + 102_815 + 50_731);
    // A single-realm account: the realm total and the version-wide total agree.
    assert.equal(dreamscythe.gold.totalKnownCopper, facts.gold.totalKnownCopper);
  } finally {
    store.close();
  }
});

test("[REAL] profession coverage on Dreamscythe shows both covered and unassigned professions", () => {
  const store = seededDreamscytheStore();
  try {
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const coverage = facts.realms[0].professions.coverage;
    const byName = new Map(coverage.map((c) => [c.profession, c]));

    // Covered, single character.
    assert.equal(byName.get("Mining")?.status, "covered");
    assert.deepEqual(byName.get("Mining")?.characters.map((c) => c.name), ["Torahn"]);

    // Covered, multiple characters - both listed, not combined into a total.
    const enchanting = byName.get("Enchanting")!;
    assert.equal(enchanting.status, "covered");
    const enchantingNames = enchanting.characters.map((c) => c.name).sort();
    assert.deepEqual(enchantingNames, ["Tenivard", "Voodan"]);
    assert.ok(enchanting.characters.every((c) => c.skill !== undefined));

    // Every relevant character's profession state IS observed (all OBSERVED),
    // so an uncovered profession is confidently "none", not "unknown".
    assert.equal(byName.get("Alchemy")?.status, "none");
    assert.equal(byName.get("Alchemy")?.characters.length, 0);
    assert.equal(byName.get("Blacksmithing")?.status, "none");

    // TBC-only profession (added after Classic Era) is present in the catalog.
    assert.ok(byName.has("Jewelcrafting"));
  } finally {
    store.close();
  }
});

// --- Retail: real two-realm account, must stay account-wide (not realm-partitioned) ---

test("[REAL] Retail combines characters across realms (Ezaller@Kel'Thuzad + Stoneharry@Thrall) into one account-wide view", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));
    store.importSnapshot(read("retail/stoneharry-1789486499.wowsync.txt"));
    store.importSnapshot(read("retail/stoneharry-1789491879.wowsync.txt"));

    const facts = store.buildAccountFacts("retail", FIXED_NOW);
    assert.equal(facts.aggregationScope, "account-wide");
    assert.equal(facts.realms.length, 0); // no realm partitioning structure for Retail
    const realms = new Set(facts.characters.map((c) => c.realm));
    assert.ok(realms.size >= 2); // these two characters really are on different realms
    assert.equal(facts.gold.totalKnownCopper, 24_797_508 + 108_357_657);
  } finally {
    store.close();
  }
});

// --- Classic Era: real single-realm isolation ---

test("[REAL] Classic Era stays realm-partitioned and isolated from TBC/Retail totals", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    store.importSnapshot(read("classic-era/bromrik-1789171621.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));

    const era = store.buildAccountFacts("classic-era", FIXED_NOW);
    assert.equal(era.aggregationScope, "realm");
    assert.equal(era.realms.length, 1);
    assert.equal(era.realms[0].realm, "Defias Pillager");
    assert.equal(era.realms[0].gold.totalKnownCopper, 304);
    assert.equal(era.characters.length, 1); // Ezaller never leaks in
  } finally {
    store.close();
  }
});

// --- Synthetic: a SECOND Classic/TBC realm must never be combined with the first ---

test("[SYNTHETIC] two TBC Anniversary realms remain fully isolated - gold, professions, and inventory", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Alpha", realm: "Dreamscythe", clientVersion: "2.5.6", moneyCopper: 1000 },
        professions: { entries: [{ name: "Mining", skill: 50, maxSkill: 300 }] },
        bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 5 }] }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Beta", realm: "Faerlina", clientVersion: "2.5.6", moneyCopper: 99_000 },
        professions: { entries: [{ name: "Tailoring", skill: 80, maxSkill: 300 }] },
        bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 40 }] }] },
      }),
    );

    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.equal(facts.realms.length, 2);
    const byRealm = new Map(facts.realms.map((r) => [r.realm, r]));

    const dreamscythe = byRealm.get("Dreamscythe")!;
    const faerlina = byRealm.get("Faerlina")!;

    // Gold never leaks between realms.
    assert.equal(dreamscythe.gold.totalKnownCopper, 1000);
    assert.equal(faerlina.gold.totalKnownCopper, 99_000);

    // Professions never leak between realms.
    assert.equal(dreamscythe.professions.coverage.find((c) => c.profession === "Mining")?.status, "covered");
    assert.equal(dreamscythe.professions.coverage.find((c) => c.profession === "Tailoring")?.status, "none");
    assert.equal(faerlina.professions.coverage.find((c) => c.profession === "Tailoring")?.status, "covered");
    assert.equal(faerlina.professions.coverage.find((c) => c.profession === "Mining")?.status, "none");

    // Inventory never leaks/combines between realms, even for the identical item.
    assert.equal(dreamscythe.inventory.items[0]?.totalKnownQty, 5);
    assert.equal(faerlina.inventory.items[0]?.totalKnownQty, 40);

    // The version-wide (broader) view is still available and DOES combine them.
    assert.equal(facts.gold.totalKnownCopper, 100_000);
  } finally {
    store.close();
  }
});

// --- Profession coverage: NONE vs UNKNOWN precision ---

test("[SYNTHETIC] a profession is 'unknown' (not 'none') on a realm where any character's professions were never observed", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Known", realm: "Dreamscythe", clientVersion: "2.5.6" },
        professions: { entries: [{ name: "Mining", skill: 10, maxSkill: 300 }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Ghost", realm: "Dreamscythe", clientVersion: "2.5.6" },
        professions: { unknown: true },
      }),
    );
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const coverage = facts.realms[0].professions.coverage;
    const byName = new Map(coverage.map((c) => [c.profession, c]));
    // Mining is covered regardless of Ghost's unknown state.
    assert.equal(byName.get("Mining")?.status, "covered");
    // Everything else can't be ruled out because Ghost's professions are unknown.
    assert.equal(byName.get("Tailoring")?.status, "unknown");
    assert.equal(byName.get("Alchemy")?.status, "unknown");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] an uncatalogued/unexpected profession name is still surfaced as covered, never dropped", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Odd", realm: "Dreamscythe", clientVersion: "2.5.6" },
        professions: { entries: [{ name: "Some Future Profession", skill: 1, maxSkill: 300 }] },
      }),
    );
    const facts = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const entry = facts.realms[0].professions.coverage.find((c) => c.profession === "Some Future Profession");
    assert.equal(entry?.status, "covered");
    assert.equal(entry?.characters[0].name, "Odd");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] unknown-version has no profession catalog - only observed professions are shown, never invented NONE/UNKNOWN entries", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Mystery", realm: "R", clientVersion: "9.9.9" } }));
    const facts = store.buildAccountFacts("unknown-version", FIXED_NOW);
    assert.equal(facts.aggregationScope, "account-wide");
    assert.equal(facts.professions.coverage.length, 0);
  } finally {
    store.close();
  }
});

// --- Determinism with realms ---

test("realm-partitioned AccountFacts is deterministic - same DB state and now produce identical output", () => {
  const store = seededDreamscytheStore();
  try {
    const a = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    const b = store.buildAccountFacts("tbc-anniversary", FIXED_NOW);
    assert.deepEqual(a, b);
  } finally {
    store.close();
  }
});
