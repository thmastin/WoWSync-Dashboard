// LLM gold context respects each version's economic scope.
//
// Classic Era / TBC Anniversary / Forever are realm-partitioned: realms share
// no economy, so the payload for those versions carries gold PER REALM and
// deliberately no version-wide total the model could mistake for one balance.
// Retail is account-wide: one total. Versions never contribute to each other.
// The canonical AccountContext (developer export) keeps both views but says,
// in-band, which one to use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REALM_SCOPE_NOTE } from "../src/accountContext.ts";
import { buildLlmContext, type LlmContext, type LlmGoldSummary, type LlmRealmGold } from "../src/llmContext.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const NOW = 1_790_000_000;
const ERA = { clientVersion: "1.15.9", clientBuild: "69547" };
const FOREVER = { clientVersion: "1.60.1", clientBuild: "69913", clientFamily: "Forever", interface: "16001" };
const RETAIL = { clientVersion: "12.1.0", clientBuild: "69814", clientFamily: "Retail", interface: "120100" };

function llmFor(store: SqliteSnapshotStore): LlmContext {
  return buildLlmContext(store.buildAccountContext(NOW));
}
function realms(summary: LlmGoldSummary): LlmRealmGold[] {
  assert.equal(summary.scope, "realm");
  if (summary.scope !== "realm") throw new Error("unreachable");
  return summary.byRealm;
}
function exp(client: object, name: string, realm: string, moneyCopper?: number, gen = NOW - 100) {
  return buildWowSyncExport({ generatedAt: gen, character: { name, realm, moneyCopper, ...client } });
}

test("[SYNTHETIC] Classic Era with two realms: one entry per realm, no version-wide total, no field anywhere holds the cross-realm sum", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(exp(ERA, "Alpha", "Firemaw", 100));
    store.importSnapshot(exp(ERA, "Beta", "Firemaw", 250));
    store.importSnapshot(exp(ERA, "Gamma", "Mankrik", 5_000_000));
    store.importSnapshot(exp(ERA, "Ghost", "Mankrik", undefined));
    const llm = llmFor(store);
    const summary = llm.versions["classic-era"].goldSummary;

    assert.deepEqual(Object.keys(summary).sort(), ["byRealm", "scope"], "no totalKnown* key at the version level");
    const [firemaw, mankrik] = realms(summary);
    assert.equal(firemaw.realm, "Firemaw");
    assert.equal(firemaw.totalKnownCopper, 350);
    assert.equal(firemaw.totalKnownFormatted, "3s 50c");
    assert.deepEqual([firemaw.charactersWithKnownGold, firemaw.charactersWithUnknownGold], [2, 0]);
    assert.equal(mankrik.realm, "Mankrik");
    assert.equal(mankrik.totalKnownCopper, 5_000_000);
    assert.equal(mankrik.totalKnownFormatted, "500g 0s 0c");
    assert.deepEqual([mankrik.charactersWithKnownGold, mankrik.charactersWithUnknownGold], [1, 1], "the unobserved character is excluded, and counted as unknown");

    // The misleading aggregate (5,000,350 copper = "500g 3s 50c") is nowhere in the payload.
    const json = JSON.stringify(llm);
    assert.equal(json.includes("5000350"), false);
    assert.equal(json.includes("500g 3s 50c"), false);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] the per-realm figures are consistent with the canonical facts (their sum equals the version-wide fact, which the projection never emits)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(exp(ERA, "Alpha", "Firemaw", 100));
    store.importSnapshot(exp(ERA, "Gamma", "Mankrik", 5_000_000));
    const ctx = store.buildAccountContext(NOW);
    const entries = realms(buildLlmContext(ctx).versions["classic-era"].goldSummary);
    const sum = entries.reduce((n, r) => n + (r.totalKnownCopper ?? 0), 0);
    assert.equal(sum, ctx.versions["classic-era"].facts.gold.totalKnownCopper);
    // ...and each entry equals its RealmGroup, field for field.
    for (const r of ctx.versions["classic-era"].facts.realms) {
      const entry = entries.find((e) => e.realm === r.realm)!;
      assert.equal(entry.totalKnownCopper, r.gold.totalKnownCopper);
      assert.equal(entry.staleCharactersWithKnownGold, r.gold.staleCharactersWithKnownGold);
      assert.equal(entry.oldestKnownGoldObservedAt, r.gold.oldestKnownGoldObservedAt);
    }
  } finally {
    store.close();
  }
});

test("[REAL] TBC Anniversary (one real realm) still uses the per-realm shape with a single entry - the shape never flips when a second realm appears", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (const f of ["voodan-1789492666", "torahn-1789492498", "tenivard-1789492580"]) {
      store.importSnapshot(read(`tbc-anniversary/${f}.wowsync.txt`));
    }
    const ctx = store.buildAccountContext(NOW);
    const summary = buildLlmContext(ctx).versions["tbc-anniversary"].goldSummary;
    const entries = realms(summary);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].realm, "Dreamscythe");
    assert.equal(entries[0].totalKnownCopper, ctx.versions["tbc-anniversary"].facts.realms[0].gold.totalKnownCopper);
    assert.equal(entries[0].charactersWithKnownGold, 3);
    assert.equal(Object.keys(summary).includes("totalKnownCopper"), false);
  } finally {
    store.close();
  }
});

test("[REAL+SYNTHETIC] Forever with two beta realms: per-realm gold, and the real Hallo figure is unchanged", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("forever/hallo-1789731867.wowsync.txt"));
    store.importSnapshot(exp(FOREVER, "Zed", "Classic Beta PvE 1", 10_000));
    const summary = buildLlmContext(store.buildAccountContext(NOW)).versions["forever"].goldSummary;
    const entries = realms(summary);
    assert.deepEqual(entries.map((r) => r.realm), ["Classic Beta PvE 1", "Classic Beta PvP 2"]);
    assert.equal(entries[0].totalKnownCopper, 10_000);
    assert.equal(entries[1].totalKnownCopper, 291);
    assert.equal(entries[1].totalKnownFormatted, "2s 91c");
    assert.equal(JSON.stringify(summary).includes("10291"), false, "the two beta realms are never added together");
  } finally {
    store.close();
  }
});

test("[REAL] Retail is account-wide: ONE total across its realms, with counts, and no per-realm structure", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt")); // Kel'Thuzad
    store.importSnapshot(read("retail/stoneharry-1789491879.wowsync.txt")); // Thrall
    const ctx = store.buildAccountContext(NOW);
    const summary = buildLlmContext(ctx).versions["retail"].goldSummary;
    assert.equal(summary.scope, "account-wide");
    if (summary.scope !== "account-wide") throw new Error("unreachable");
    assert.equal(summary.totalKnownCopper, ctx.versions["retail"].facts.gold.totalKnownCopper);
    assert.equal(summary.charactersWithKnownGold, 2);
    assert.equal("byRealm" in summary, false);
    // Two different Retail realms really do combine (account-wide sharing).
    const chars = buildLlmContext(ctx).versions["retail"].characters;
    assert.equal(new Set(chars.map((c) => c.realm)).size, 2);
    assert.equal(summary.totalKnownCopper, chars.reduce((n, c) => n + (c.goldCopper ?? 0), 0));
  } finally {
    store.close();
  }
});

test("[REAL+SYNTHETIC] versions never contribute to each other: every version's gold comes only from its own characters", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789171621.wowsync.txt")); // 304c
    store.importSnapshot(read("forever/hallo-1789731867.wowsync.txt")); // 291c
    store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));
    store.importSnapshot(exp(RETAIL, "Solo", "Tichondrius", 7));
    const llm = llmFor(store);
    assert.equal(realms(llm.versions["classic-era"].goldSummary)[0].totalKnownCopper, 304);
    assert.equal(realms(llm.versions["forever"].goldSummary)[0].totalKnownCopper, 291);
    assert.deepEqual(realms(llm.versions["tbc-anniversary"].goldSummary), [], "an empty realm-scoped version has no entries");
    const json = JSON.stringify(llm);
    assert.equal(json.includes("\"595\""), false);
    assert.equal(json.includes(String(304 + 291)), false, "no cross-version sum");
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] an observed 0 copper is a real total of 0, while an unobserved realm has no total at all - the two are never conflated", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(exp(ERA, "Broke", "Firemaw", 0));
    store.importSnapshot(exp(ERA, "Ghost", "Mankrik", undefined));
    const [firemaw, mankrik] = realms(llmFor(store).versions["classic-era"].goldSummary);
    assert.equal(firemaw.totalKnownCopper, 0);
    assert.equal(firemaw.totalKnownFormatted, "0c");
    assert.equal(firemaw.charactersWithKnownGold, 1);
    assert.equal(mankrik.totalKnownCopper, undefined);
    assert.equal(mankrik.totalKnownFormatted, undefined);
    assert.equal(mankrik.charactersWithKnownGold, 0);
    assert.equal(mankrik.charactersWithUnknownGold, 1);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] the freshness of each realm's gold is projected: stale counts and the oldest observation, per realm", () => {
  // Imported at NOW: the exports claim to be up to 20 days old at that moment (a snapshot
  // cannot have been observed after it was imported - see chronology.ts).
  mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const old = NOW - 20 * 86400;
    store.importSnapshot(exp(ERA, "Old", "Firemaw", 100, old));
    store.importSnapshot(exp(ERA, "New", "Mankrik", 200, NOW - 60));
    const [firemaw, mankrik] = realms(llmFor(store).versions["classic-era"].goldSummary);
    assert.equal(firemaw.staleCharactersWithKnownGold, 1);
    assert.equal(firemaw.oldestKnownGoldObservedAt, old);
    assert.equal(mankrik.staleCharactersWithKnownGold, 0);
    assert.equal(mankrik.oldestKnownGoldObservedAt, NOW - 60);
  } finally {
    mock.timers.reset();
    store.close();
  }
});

test("[SYNTHETIC] an empty account-wide version says so with zero counts and NO total (not '0c')", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const summary = llmFor(store).versions["retail"].goldSummary;
    assert.equal(summary.scope, "account-wide");
    if (summary.scope !== "account-wide") throw new Error("unreachable");
    assert.equal(summary.charactersWithKnownGold, 0);
    assert.equal(summary.totalKnownCopper, undefined);
    assert.equal(summary.totalKnownFormatted, undefined);
  } finally {
    store.close();
  }
});

// --- The canonical AccountContext (developer export) ------------------------------------------

test("[SYNTHETIC] the canonical export tells its reader, in-band, that realm-partitioned totals are derived cross-realm sums", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(exp(ERA, "Alpha", "Firemaw", 100));
    const ctx = store.buildAccountContext(NOW);
    assert.equal(ctx.versions["classic-era"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal(ctx.versions["tbc-anniversary"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal(ctx.versions["forever"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal("scopeNote" in ctx.versions["retail"], false, "Retail is account-wide: no such caveat");
    assert.match(REALM_SCOPE_NOTE, /facts\.realms\[\]/);
    assert.match(REALM_SCOPE_NOTE, /never present a cross-realm sum as one account balance/);
    // Both views are still present for consumers that need them.
    assert.equal(ctx.versions["classic-era"].facts.gold.totalKnownCopper, 100);
    assert.equal(ctx.versions["classic-era"].facts.realms[0].gold.totalKnownCopper, 100);
  } finally {
    store.close();
  }
});

test("the currency convention documents that a total over zero observed values is unknown, not zero", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const { currency } = store.buildAccountContext(NOW);
    assert.match(currency.note, /sum over nothing observed/);
    assert.match(currency.note, /NOT zero gold/);
    assert.match(currency.note, /never gold/, "the pre-existing copper convention is intact");
  } finally {
    store.close();
  }
});
