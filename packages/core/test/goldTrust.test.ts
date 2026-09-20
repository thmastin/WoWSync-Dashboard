// Trust semantics for gold/playtime totals:
//   - UNKNOWN gold is never 0: an unobserved character contributes nothing,
//     and a scope with no known gold does not report a numeric 0 total in the
//     places that summarise versions.
//   - An OBSERVED 0 copper is a real, known value (known count 1, total 0).
//   - A total says how many of its contributors are stale (existing fixed
//     3-day rule from freshness.ts - no configurable threshold) and how old
//     its oldest contribution is. STALE is an observed age, never a judgement,
//     and an unknown-gold character is never "stale", only unknown.
// Real Retail fixtures for the stale/current cases; [SYNTHETIC] exports where
// the real data cannot express the case (unknown gold, observed zero).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RECENT_THRESHOLD_SECONDS } from "../src/freshness.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const ERA = { clientVersion: "1.15.9", clientBuild: "69547" };
const GEN = 1_789_000_000;
const CLOCK_MS = 1_790_000_000_000;

function exp(name: string, realm: string, gen: number, moneyCopper?: number, extra: { playedSeconds?: number } = {}) {
  return buildWowSyncExport({
    generatedAt: gen,
    character: { name, realm, moneyCopper, playedSeconds: extra.playedSeconds, ...ERA },
  });
}

function withClock<T>(fn: () => T): T {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

// --- Unknown is not zero ------------------------------------------------------------

test("[SYNTHETIC] unknown gold and observed zero gold are distinguishable in AccountFacts", () => {
  withClock(() => {
    const unknown = new SqliteSnapshotStore(":memory:");
    const zero = new SqliteSnapshotStore(":memory:");
    try {
      unknown.importSnapshot(exp("Ghost", "Firemaw", GEN, undefined));
      zero.importSnapshot(exp("Broke", "Firemaw", GEN, 0));
      const u = unknown.buildAccountFacts("classic-era", GEN + 60).gold;
      const z = zero.buildAccountFacts("classic-era", GEN + 60).gold;

      assert.equal(u.charactersWithKnownGold, 0);
      assert.equal(u.charactersWithUnknownGold, 1);
      assert.equal(u.byCharacter[0].goldCopper, undefined, "an unobserved character never becomes 0 copper");
      assert.equal(u.oldestKnownGoldObservedAt, undefined, "no known contributor => no oldest observation");
      assert.equal(u.staleCharactersWithKnownGold, 0);

      assert.equal(z.charactersWithKnownGold, 1);
      assert.equal(z.charactersWithUnknownGold, 0);
      assert.equal(z.totalKnownCopper, 0, "a legitimate observed 0 copper");
      assert.equal(z.byCharacter[0].goldCopper, 0);
      assert.equal(z.oldestKnownGoldObservedAt, GEN);
      assert.notDeepEqual(u, z);
    } finally {
      unknown.close();
      zero.close();
    }
  });
});

test("[SYNTHETIC] a version summary reports NO gold total when no character's gold was ever observed, and a real 0 when one was", () => {
  withClock(() => {
    const unknown = new SqliteSnapshotStore(":memory:");
    const zero = new SqliteSnapshotStore(":memory:");
    try {
      unknown.importSnapshot(exp("Ghost", "Firemaw", GEN, undefined, { playedSeconds: undefined }));
      zero.importSnapshot(exp("Broke", "Firemaw", GEN, 0, { playedSeconds: 0 }));

      const u = unknown.listVersions().find((v) => v.version === "classic-era")!;
      assert.equal(u.charactersWithKnownGold, 0);
      assert.equal(u.totalMoneyCopper, undefined, "a sum over nothing observed is not '0 copper'");
      assert.equal(u.charactersWithKnownPlaytime, 0);
      assert.equal(u.totalPlayedSeconds, undefined);
      assert.equal("totalMoneyCopper" in JSON.parse(JSON.stringify(u)), false, "absent from the wire format, not null");

      const z = zero.listVersions().find((v) => v.version === "classic-era")!;
      assert.equal(z.charactersWithKnownGold, 1);
      assert.equal(z.totalMoneyCopper, 0);
      assert.equal(z.totalPlayedSeconds, 0);
    } finally {
      unknown.close();
      zero.close();
    }
  });
});

test("[SYNTHETIC] realm scope: a realm with only unobserved gold reports none, while its sibling realm keeps its total", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(exp("Ghost", "Firemaw", GEN, undefined));
      store.importSnapshot(exp("Rich", "Mankrik", GEN, 5_000_000));
      const facts = store.buildAccountFacts("classic-era", GEN + 60);
      const byRealm = new Map(facts.realms.map((r) => [r.realm, r.gold]));
      assert.equal(byRealm.get("Firemaw")!.charactersWithKnownGold, 0);
      assert.equal(byRealm.get("Firemaw")!.byCharacter[0].goldCopper, undefined);
      assert.equal(byRealm.get("Mankrik")!.totalKnownCopper, 5_000_000);
      assert.equal(byRealm.get("Mankrik")!.charactersWithKnownGold, 1);
    } finally {
      store.close();
    }
  });
});

// --- Freshness-aware totals ---------------------------------------------------------------

test("[REAL] Retail gold total counts stale contributors: none an hour after the exports, both four days later", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));
    store.importSnapshot(read("retail/stoneharry-1789486499.wowsync.txt"));
    store.importSnapshot(read("retail/stoneharry-1789491879.wowsync.txt"));
    const newest = 1_789_491_879; // Stoneharry's latest export

    const fresh = store.buildAccountFacts("retail", newest + 3600).gold;
    assert.equal(fresh.charactersWithKnownGold, 2);
    assert.equal(fresh.staleCharactersWithKnownGold, 0);
    assert.equal(fresh.oldestKnownGoldObservedAt, 1_789_478_317, "Ezaller's latest export is the oldest contribution");

    const old = store.buildAccountFacts("retail", newest + 4 * 86400).gold;
    assert.equal(old.staleCharactersWithKnownGold, 2);
    assert.equal(old.charactersWithKnownGold, 2);
    // The total itself is unchanged - staleness is stated, never subtracted or hidden.
    assert.equal(old.totalKnownCopper, fresh.totalKnownCopper);
    assert.equal(old.oldestKnownGoldObservedAt, 1_789_478_317);
  } finally {
    store.close();
  }
});

test("[SYNTHETIC] the recent/stale boundary is the existing 3-day rule, exactly", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(exp("Edge", "Firemaw", GEN, 100));
      assert.equal(store.buildAccountFacts("classic-era", GEN + RECENT_THRESHOLD_SECONDS).gold.staleCharactersWithKnownGold, 0);
      assert.equal(store.buildAccountFacts("classic-era", GEN + RECENT_THRESHOLD_SECONDS + 1).gold.staleCharactersWithKnownGold, 1);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] unknown-gold characters are never counted stale; a stale legitimate 0 copper is; recent known ones are not", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const now = GEN + 10 * 86400;
      store.importSnapshot(exp("Ghost", "Firemaw", GEN, undefined)); // stale AND unknown gold
      store.importSnapshot(exp("Broke", "Firemaw", GEN + 100, 0)); // stale, known 0
      store.importSnapshot(exp("Fresh", "Firemaw", now - 60, 777)); // recent, known
      const gold = store.buildAccountFacts("classic-era", now).gold;
      assert.equal(gold.charactersWithKnownGold, 2);
      assert.equal(gold.charactersWithUnknownGold, 1);
      assert.equal(gold.staleCharactersWithKnownGold, 1, "only Broke: known and stale");
      assert.equal(gold.oldestKnownGoldObservedAt, GEN + 100, "the unknown character's snapshot does not set the oldest age");
      assert.equal(gold.totalKnownCopper, 777);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] realm groups carry their own freshness fields (a realm whose only contributor is stale says so)", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const now = GEN + 6 * 86400;
      store.importSnapshot(exp("OldOne", "Firemaw", GEN, 100));
      store.importSnapshot(exp("NewOne", "Mankrik", now - 5, 200));
      const facts = store.buildAccountFacts("classic-era", now);
      const byRealm = new Map(facts.realms.map((r) => [r.realm, r.gold]));
      assert.equal(byRealm.get("Firemaw")!.staleCharactersWithKnownGold, 1);
      assert.equal(byRealm.get("Firemaw")!.oldestKnownGoldObservedAt, GEN);
      assert.equal(byRealm.get("Mankrik")!.staleCharactersWithKnownGold, 0);
      assert.equal(byRealm.get("Mankrik")!.oldestKnownGoldObservedAt, now - 5);
      // The version-wide figure aggregates both and is stale-aware too.
      assert.equal(facts.gold.staleCharactersWithKnownGold, 1);
      assert.equal(facts.gold.oldestKnownGoldObservedAt, GEN);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] playtime totals get the same freshness fields", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const now = GEN + 10 * 86400;
      store.importSnapshot(exp("Old", "Firemaw", GEN, 1, { playedSeconds: 100 }));
      store.importSnapshot(exp("New", "Firemaw", now - 5, 1, { playedSeconds: 50 }));
      store.importSnapshot(exp("Unk", "Firemaw", GEN, 1, { playedSeconds: undefined }));
      const p = store.buildAccountFacts("classic-era", now).playtime;
      assert.equal(p.charactersWithKnownPlaytime, 2);
      assert.equal(p.staleCharactersWithKnownPlaytime, 1);
      assert.equal(p.oldestKnownPlaytimeObservedAt, GEN);
      assert.equal(p.totalKnownPlayedSeconds, 150);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] the freshness fields are deterministic for a fixed `now`", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(exp("A", "Firemaw", GEN, 5));
      const a = JSON.stringify(store.buildAccountFacts("classic-era", GEN + 5 * 86400));
      const b = JSON.stringify(store.buildAccountFacts("classic-era", GEN + 5 * 86400));
      assert.equal(a, b);
    } finally {
      store.close();
    }
  });
});
