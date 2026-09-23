// LlmContext ("LLM Context v1") regression tests. Named after the three
// live characters whose real behavior motivated each rule - see the
// LLM-evaluation sessions this projection was built to fix:
//   - Hanzazz: one snapshot, no comparison possible. The model fabricated
//     an entire inventory transition for this shape by cross-contaminating
//     it with a different character's real data - comparisonStatus makes
//     "no comparison exists" an explicit field instead of an inferred one.
//   - Squashpot: multiple snapshots with real inventory gains and losses.
//   - Stoneharry: four snapshots, where the model previously paired the
//     correct latest-transition delta with the OLDEST snapshot's gold
//     instead of the correct second-to-latest snapshot's gold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLlmContext, type LlmGoldSummary, type LlmRealmGold } from "../src/llmContext.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const FIXED_NOW = 1_800_000_000;
const RETAIL = { clientVersion: "12.1.0", clientFamily: "Retail", interface: "120100" };

function llmCharacter(store: SqliteSnapshotStore, name: string) {
  const ctx = store.buildAccountContext(FIXED_NOW);
  const llm = buildLlmContext(ctx);
  const ch = llm.versions["retail"].characters.find((c) => c.name === name);
  assert.ok(ch, `expected a projected character named ${name}`);
  return ch!;
}

// --- Hanzazz regression: one snapshot, no comparison possible ---

test("[SYNTHETIC] a single-snapshot character gets comparisonStatus INSUFFICIENT_HISTORY and no latestTransition at all", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Lonewolf", realm: "Tichondrius", level: 37, moneyCopper: 10788805, ...RETAIL } }),
    );
    const ch = llmCharacter(store, "Lonewolf");

    assert.equal(ch.snapshotCount, 1);
    assert.equal(ch.comparisonStatus, "INSUFFICIENT_HISTORY");
    assert.equal(ch.latestTransition, undefined);
    // Never a fabricated zero/empty object - the key itself must not
    // survive serialization, not just hold an undefined value.
    assert.equal("latestTransition" in JSON.parse(JSON.stringify(ch)), false);
  } finally {
    store.close();
  }
});

// --- Squashpot regression: real gains and losses, atomically colocated ---

test("[SYNTHETIC] a multi-snapshot character with inventory changes gets comparisonStatus AVAILABLE with a consistent, atomic latestTransition", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: 1_789_508_582,
        character: { name: "Bigbags", realm: "Cairne", level: 69, moneyCopper: 588483674, playedSeconds: 501684, ...RETAIL },
        bags: {
          containers: [
            { id: 0, capacity: 20, free: 10, items: [{ itemRef: "item:108979", name: "Bleached Bones", qty: 5 }] },
          ],
        },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: 1_789_523_607,
        character: { name: "Bigbags", realm: "Cairne", level: 80, moneyCopper: 606021464, playedSeconds: 504584, ...RETAIL },
        bags: {
          containers: [
            { id: 0, capacity: 20, free: 8, items: [{ itemRef: "item:169223", name: "Ashjra'kamas, Shroud of Resolve", qty: 1 }] },
          ],
        },
      }),
    );
    const ch = llmCharacter(store, "Bigbags");

    assert.equal(ch.comparisonStatus, "AVAILABLE");
    assert.ok(ch.latestTransition);
    const t = ch.latestTransition!;

    assert.equal(t.fromLevel, 69);
    assert.equal(t.toLevel, 80);
    assert.equal(t.levelChanged, true);
    assert.equal(t.previousGoldCopper, 588483674);
    assert.equal(t.currentGoldCopper, 606021464);
    assert.equal(t.goldDeltaCopper, 606021464 - 588483674);
    assert.equal(t.goldDeltaFormatted, "+1,753g 77s 90c");
    assert.equal(t.playtimeDeltaSeconds, 504584 - 501684);

    assert.ok(t.inventory);
    assert.deepEqual(
      t.inventory!.gained.map((i) => i.name),
      ["Ashjra'kamas, Shroud of Resolve"],
    );
    assert.deepEqual(
      t.inventory!.lost.map((i) => i.name),
      ["Bleached Bones"],
    );
    assert.equal(t.inventory!.gained[0].qty, 1);
    assert.equal(t.inventory!.lost[0].qty, 5); // positive - list membership carries the direction
  } finally {
    store.close();
  }
});

// --- Stoneharry regression: the oldest snapshot must never leak into the latest transition ---

test("[SYNTHETIC] the latest transition's previous-gold endpoint is the second-to-latest snapshot, never the oldest one", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    // Real magnitudes from the live regression (Stoneharry, TBC Timerunning -> level 80 leveling spree).
    const snapshots: [number, number, number][] = [
      [1_789_486_499, 56, 98762099],
      [1_789_491_879, 66, 108357657],
      [1_789_495_395, 71, 113001486],
      [1_789_500_899, 80, 127343549],
    ];
    for (const [generatedAt, level, moneyCopper] of snapshots) {
      store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Goldrush", realm: "Thrall", level, moneyCopper, ...RETAIL } }));
    }
    const ch = llmCharacter(store, "Goldrush");

    assert.equal(ch.comparisonStatus, "AVAILABLE");
    const t = ch.latestTransition!;
    assert.equal(t.fromLevel, 71);
    assert.equal(t.toLevel, 80);
    assert.equal(t.previousGoldCopper, 113001486);
    assert.equal(t.currentGoldCopper, 127343549);
    assert.equal(t.goldDeltaCopper, 14342063);
    assert.notEqual(t.previousGoldCopper, 98762099); // the oldest snapshot's gold must not leak in
  } finally {
    store.close();
  }
});

// --- UNKNOWN preservation ---

test("[SYNTHETIC] unobserved gold and profession data stay absent, never zero/false/empty/'none'", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Ghost", realm: "Cairne", moneyCopper: undefined, ...RETAIL },
        professions: { unknown: true },
        bank: { unknown: true },
      }),
    );
    const ch = llmCharacter(store, "Ghost");

    assert.equal(ch.goldCopper, undefined);
    assert.equal(ch.goldFormatted, undefined); // never "0g 0s 0c" for an unobserved value
    assert.equal(ch.bankStatus, "UNKNOWN");
    assert.deepEqual(ch.professions, []); // observed-empty-list is fine here; the character-level status carries the UNKNOWN signal elsewhere in AccountFacts, unchanged by this projection
  } finally {
    store.close();
  }
});

// --- Character isolation ---

test("[SYNTHETIC] inventory changes for one character never appear under a different character's projected object", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    // Character A: real inventory change.
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: 1_700_000_000,
        character: { name: "Alpha", realm: "Cairne", moneyCopper: 100, ...RETAIL },
        bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [] }] },
      }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        generatedAt: 1_700_000_600,
        character: { name: "Alpha", realm: "Cairne", moneyCopper: 100, ...RETAIL },
        bags: { containers: [{ id: 0, capacity: 16, free: 14, items: [{ itemRef: "item:9999", name: "Suspicious Trinket", qty: 1 }] }] },
      }),
    );
    // Character B: same realm, no inventory change at all (only one snapshot).
    store.importSnapshot(buildWowSyncExport({ character: { name: "Beta", realm: "Cairne", moneyCopper: 500, ...RETAIL } }));

    const ctx = store.buildAccountContext(FIXED_NOW);
    const llm = buildLlmContext(ctx);
    const alpha = llm.versions["retail"].characters.find((c) => c.name === "Alpha")!;
    const beta = llm.versions["retail"].characters.find((c) => c.name === "Beta")!;

    assert.equal(alpha.comparisonStatus, "AVAILABLE");
    assert.deepEqual(
      alpha.latestTransition!.inventory!.gained.map((i) => i.name),
      ["Suspicious Trinket"],
    );

    assert.equal(beta.comparisonStatus, "INSUFFICIENT_HISTORY");
    assert.equal(beta.latestTransition, undefined);

    // The whole serialized document should mention "Suspicious Trinket" exactly once, under Alpha only.
    const raw = JSON.stringify(llm);
    const occurrences = raw.split("Suspicious Trinket").length - 1;
    assert.equal(occurrences, 1);
    assert.ok(raw.indexOf("Suspicious Trinket") > raw.indexOf('"identityKey":"retail::cairne::alpha"'));
  } finally {
    store.close();
  }
});

// --- latestTransitionIndex: the discovery-burden experiment ---
//
// Live testing found the per-character shapes above were all individually
// correct, but a model asked to filter/enumerate across many characters
// (e.g. "which characters gained or lost gold") did not reliably discover
// and report the complete qualifying set itself - it omitted later,
// larger entries. latestTransitionIndex hands the model that set directly
// as identityKeys, computed once, deterministically, from the exact same
// latestTransition fields already on each character (no second
// calculation path, no duplicated values).

function buildIndexFixture(): SqliteSnapshotStore {
  const store = new SqliteSnapshotStore(":memory:");
  const item = (id: string, name: string, qty: number) => ({ itemRef: `item:${id}`, name, qty });

  // Voodan: comparable, gold changed, inventory changed.
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Voodan", realm: "Cairne", moneyCopper: 100, ...RETAIL } }));
  store.importSnapshot(
    buildWowSyncExport({
      generatedAt: 2,
      character: { name: "Voodan", realm: "Cairne", moneyCopper: 200, ...RETAIL },
      bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [item("1", "Raptor Egg", 1)] }] },
    }),
  );
  // Ciao (Cairne): comparable, gold changed, inventory changed (gains only, mirrors the real shape).
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Ciao", realm: "Cairne", moneyCopper: 500, ...RETAIL } }));
  store.importSnapshot(
    buildWowSyncExport({
      generatedAt: 2,
      character: { name: "Ciao", realm: "Cairne", moneyCopper: 700, ...RETAIL },
      bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [item("2", "Chitinous Armor Fragment", 5)] }] },
    }),
  );
  // Fromiste: comparable, but a genuine observed zero on both gold and inventory - must NOT appear in either *Changed list.
  const fromisteBags = { containers: [{ id: 0, capacity: 16, free: 15, items: [item("3", "Lemon Silverleaf Tea", 1)] }] };
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Fromiste", realm: "Wyrmrest Accord", moneyCopper: 900, ...RETAIL }, bags: fromisteBags }));
  store.importSnapshot(buildWowSyncExport({ generatedAt: 2, character: { name: "Fromiste", realm: "Wyrmrest Accord", moneyCopper: 900, ...RETAIL }, bags: fromisteBags }));
  // Squashpot: comparable, gold changed, inventory changed.
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Squashpot", realm: "Cairne", moneyCopper: 1000, ...RETAIL } }));
  store.importSnapshot(
    buildWowSyncExport({
      generatedAt: 2,
      character: { name: "Squashpot", realm: "Cairne", moneyCopper: 2000, ...RETAIL },
      bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [item("4", "Ashjra'kamas, Shroud of Resolve", 1)] }] },
    }),
  );
  // Stoneharry: comparable, gold changed, inventory changed.
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Stoneharry", realm: "Thrall", moneyCopper: 3000, ...RETAIL } }));
  store.importSnapshot(
    buildWowSyncExport({
      generatedAt: 2,
      character: { name: "Stoneharry", realm: "Thrall", moneyCopper: 5000, ...RETAIL },
      bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [item("5", "Large Green Bag", 1)] }] },
    }),
  );
  // Hanzazz: one snapshot only - insufficient history, not comparable, not in any *Changed list.
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Hanzazz", realm: "Tichondrius", moneyCopper: 10788805, ...RETAIL } }));
  // Unknowngold: comparable, but gold was never observed on either snapshot - must be excluded from goldChanged (not treated as an observed zero).
  store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Unknowngold", realm: "Cairne", moneyCopper: undefined, ...RETAIL } }));
  store.importSnapshot(buildWowSyncExport({ generatedAt: 2, character: { name: "Unknowngold", realm: "Cairne", moneyCopper: undefined, ...RETAIL } }));

  return store;
}

test("[SYNTHETIC] latestTransitionIndex.comparable and .insufficientHistory correctly partition every character", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const idx = llm.latestTransitionIndex;
    const key = (name: string, realm: string) => `retail::${realm.toLowerCase()}::${name.toLowerCase()}`;

    assert.deepEqual(new Set(idx.comparable), new Set([
      key("Voodan", "Cairne"), key("Ciao", "Cairne"), key("Fromiste", "Wyrmrest Accord"),
      key("Squashpot", "Cairne"), key("Stoneharry", "Thrall"), key("Unknowngold", "Cairne"),
    ]));
    assert.deepEqual(idx.insufficientHistory, [key("Hanzazz", "Tichondrius")]);
    // Disjoint - never both comparable and insufficientHistory.
    for (const k of idx.comparable) assert.ok(!idx.insufficientHistory.includes(k));
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] latestTransitionIndex.goldChanged and .inventoryChanged list exactly the characters with an observed non-zero change", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const idx = llm.latestTransitionIndex;
    const key = (name: string, realm: string) => `retail::${realm.toLowerCase()}::${name.toLowerCase()}`;
    const changed = [key("Voodan", "Cairne"), key("Ciao", "Cairne"), key("Squashpot", "Cairne"), key("Stoneharry", "Thrall")];

    assert.deepEqual(new Set(idx.goldChanged), new Set(changed));
    assert.deepEqual(new Set(idx.inventoryChanged), new Set(changed));

    // Fromiste: comparable, genuine observed zero on both dimensions - excluded from both.
    const fromiste = key("Fromiste", "Wyrmrest Accord");
    assert.ok(!idx.goldChanged.includes(fromiste));
    assert.ok(!idx.inventoryChanged.includes(fromiste));
    assert.ok(idx.comparable.includes(fromiste));

    // Unknowngold: comparable, but gold was never observed - must not be misread as an observed zero.
    const unknowngold = key("Unknowngold", "Cairne");
    assert.ok(!idx.goldChanged.includes(unknowngold));
    assert.ok(idx.comparable.includes(unknowngold));

    // Hanzazz: insufficient history - absent from every *Changed list, never inferred as unchanged.
    const hanzazz = key("Hanzazz", "Tichondrius");
    assert.ok(!idx.goldChanged.includes(hanzazz));
    assert.ok(!idx.inventoryChanged.includes(hanzazz));
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] an unobserved gold value never enters goldChanged, and its latestTransition.goldDeltaCopper stays absent (not zero)", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const unknowngold = llm.versions["retail"].characters.find((c) => c.name === "Unknowngold")!;
    assert.equal(unknowngold.comparisonStatus, "AVAILABLE");
    assert.equal(unknowngold.latestTransition!.goldDeltaCopper, undefined);
    assert.ok(!llm.latestTransitionIndex.goldChanged.includes(unknowngold.identityKey));
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] the index contains only identityKey strings - no item names, gold values, or transition objects leak in", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const idx = llm.latestTransitionIndex;
    for (const list of Object.values(idx)) {
      assert.ok(Array.isArray(list));
      for (const entry of list) assert.equal(typeof entry, "string");
    }
    // Check array VALUES only (not the field names themselves, which
    // legitimately contain words like "inventoryChanged").
    const allValues = Object.values(idx).flat().join(",");
    assert.doesNotMatch(allValues, /Raptor Egg|Chitinous Armor Fragment|Ashjra|Large Green Bag/);
    assert.doesNotMatch(allValues, /goldDeltaCopper|fromLevel|toLevel|\d{3,}/); // no numbers/field names, identityKeys only
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] index arrays preserve the same canonical order as the versions[...].characters arrays", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const canonicalOrder: string[] = [];
    for (const vc of Object.values(llm.versions)) for (const ch of vc.characters) canonicalOrder.push(ch.identityKey);

    for (const [field, list] of Object.entries(llm.latestTransitionIndex)) {
      const positions = list.map((k: string) => canonicalOrder.indexOf(k));
      const sorted = [...positions].sort((a, b) => a - b);
      assert.deepEqual(positions, sorted, `${field} is not in canonical order`);
    }
  } finally {
    store.close();
  }
});

// --- goldSummary: the missing-aggregate experiment ---
//
// Live testing found individual character goldCopper/goldFormatted were
// always correct, but asked for a "total Retail gold" figure with no
// deterministic aggregate supplied, the model invented one - and its
// invented total exactly equalled its (also invented) figure for one
// character. goldSummary therefore carries an already-computed total into
// LlmContext - never a second calculation path. Realm-partitioned versions
// (Classic Era / TBC Anniversary / Forever) get one entry PER REALM (each
// realm's own RealmGroup.gold) and no version-wide total, because a
// cross-realm sum contradicted the prompt's "never combine realms" rule;
// account-wide Retail keeps a single total. The realm-scope cases live in
// realmGoldContext.test.ts; the tests here are the classic-era projections
// that used to read the version-wide total.

/** The per-realm gold entries of a realm-scoped summary (fails the test for any other shape). */
function realmEntries(summary: LlmGoldSummary): LlmRealmGold[] {
  assert.equal(summary.scope, "realm", "a realm-partitioned version must never carry a single version-wide gold total");
  if (summary.scope !== "realm") throw new Error("unreachable");
  return summary.byRealm;
}

test("[SYNTHETIC] goldSummary's realm total is that realm's canonical RealmGroup gold, projected unchanged", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Alpha", realm: "R", moneyCopper: 100 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Beta", realm: "R", moneyCopper: 250 } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    const llm = buildLlmContext(ctx);
    const entries = realmEntries(llm.versions["classic-era"].goldSummary);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].realm, "R");
    assert.equal(entries[0].totalKnownCopper, ctx.versions["classic-era"].facts.realms[0].gold.totalKnownCopper);
    assert.equal(entries[0].totalKnownCopper, 350);
    assert.equal(entries[0].charactersWithKnownGold, 2);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] goldSummary.totalKnownFormatted is the correct deterministic formatting of that exact value", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Rich", realm: "R", moneyCopper: 92113121 } }));
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const [realm] = realmEntries(llm.versions["classic-era"].goldSummary);
    assert.equal(realm.totalKnownCopper, 92113121);
    assert.equal(realm.totalKnownFormatted, "9,211g 31s 21c");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] when no character's gold was ever observed, goldSummary is unknown - not a misleading '0c' total", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "R", moneyCopper: undefined } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    assert.equal(ctx.versions["classic-era"].facts.gold.charactersWithKnownGold, 0);
    const llm = buildLlmContext(ctx);
    const [realm] = realmEntries(llm.versions["classic-era"].goldSummary);
    assert.equal(realm.totalKnownCopper, undefined);
    assert.equal(realm.totalKnownFormatted, undefined);
    assert.equal("totalKnownCopper" in JSON.parse(JSON.stringify(realm)), false, "absent from the serialised payload, not null or 0");
    assert.equal(realm.charactersWithKnownGold, 0);
    assert.equal(realm.charactersWithUnknownGold, 1);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] the projection never independently sums character gold - it carries the realm's canonical total as-is, even if deliberately inconsistent with it", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Alpha", realm: "R", moneyCopper: 100 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Beta", realm: "R", moneyCopper: 250 } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    // Naively summing the two characters' goldCopper would give 350.
    // Deliberately desync the realm's canonical total from that sum to prove
    // buildLlmContext reads RealmGroup.gold.totalKnownCopper verbatim rather
    // than recomputing it from the projected characters.
    ctx.versions["classic-era"].facts.realms[0].gold.totalKnownCopper = 999999;
    // ...and poison the version-wide figure to prove it is never read for a realm-scoped version.
    ctx.versions["classic-era"].facts.gold.totalKnownCopper = 123456789;
    const llm = buildLlmContext(ctx);
    const [realm] = realmEntries(llm.versions["classic-era"].goldSummary);
    assert.equal(realm.totalKnownCopper, 999999);
    assert.notEqual(realm.totalKnownCopper, 350);
    assert.equal(JSON.stringify(llm).includes("123456789"), false);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] adding goldSummary leaves individual character goldCopper/goldFormatted unchanged", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Alpha", realm: "R", moneyCopper: 92113121 } }));
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const alpha = llm.versions["classic-era"].characters.find((c) => c.name === "Alpha")!;
    assert.equal(alpha.goldCopper, 92113121);
    assert.equal(alpha.goldFormatted, "9,211g 31s 21c");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] adding goldSummary leaves latestTransitionIndex behavior unchanged", () => {
  const store = buildIndexFixture();
  try {
    const llm = buildLlmContext(store.buildAccountContext(FIXED_NOW));
    const idx = llm.latestTransitionIndex;
    const key = (name: string, realm: string) => `retail::${realm.toLowerCase()}::${name.toLowerCase()}`;
    const changed = [key("Voodan", "Cairne"), key("Ciao", "Cairne"), key("Squashpot", "Cairne"), key("Stoneharry", "Thrall")];
    assert.deepEqual(new Set(idx.goldChanged), new Set(changed));
    assert.deepEqual(new Set(idx.inventoryChanged), new Set(changed));
    assert.ok(llm.versions["retail"].goldSummary); // still present alongside the unchanged index
  } finally {
    store.close();
  }
});

// --- Bloat regression ---
//
// Ceiling chosen deliberately generous, not a tight budget: measured
// against this exact one-character/two-snapshot fixture, LlmContext
// currently serializes to ~1.4KB (vs. ~6.9KB for the canonical
// AccountContext over the same data - about 80% smaller). Against the
// live database (12 characters across 3 versions, real multi-snapshot
// history, real inventory changes) it measured 15,537 bytes vs. 319,233
// bytes canonical - a 95.1% reduction. 8,000 bytes for this minimal
// single-character fixture is ~6x the measured value: enough headroom
// that ordinary field additions won't trip it, while still catching an
// actual regression (e.g. accidentally including the full per-character
// snapshotHistory or all historical transitions again).
const BLOAT_CEILING_BYTES = 8_000;

test("[SYNTHETIC] the projected document is substantially smaller than the canonical AccountContext for the same data, and stays under a generous absolute ceiling", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: 1, character: { name: "Solo", realm: "Cairne", moneyCopper: 100, ...RETAIL } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: 2, character: { name: "Solo", realm: "Cairne", moneyCopper: 200, ...RETAIL } }));
    const ctx = store.buildAccountContext(FIXED_NOW);
    const llm = buildLlmContext(ctx);
    const llmSize = JSON.stringify(llm).length;
    assert.ok(llmSize < JSON.stringify(ctx).length, "LlmContext must be smaller than the canonical AccountContext");
    assert.ok(llmSize < BLOAT_CEILING_BYTES, `LlmContext grew to ${llmSize} bytes for a single-character fixture - review what was added`);
  } finally {
    store.close();
  }
});
