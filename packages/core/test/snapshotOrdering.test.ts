// Snapshot chronology and import idempotency.
//
// The semantic that matters is "when did the game state actually exist" -
// the export's own Generated timestamp - not "when did we happen to import
// it". So:
//   - "latest"/"previous" everywhere (store summaries, history, recent
//     changes, diffs) follow COALESCE(generated_at, imported_at), then row id,
//     which is exactly the order AccountContext already used;
//   - importing an OLDER export later must not become current state, must not
//     produce a reversed "change", and must not overwrite newer class/faction;
//   - importing the SAME export twice is a no-op: no fake history, and the
//     real earlier transition is not erased by a zero-delta duplicate pair.
// "Same" is decided by content: same character, same Generated value AND the
// same export text (after CRLF/trailing-whitespace normalisation). Two
// different exports that share a Generated timestamp (1-second resolution)
// are both real observations and both kept.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const ERA = { clientVersion: "1.15.9", clientBuild: "69547" };
const KEY = "classic-era::firemaw::ordo";
const GEN = 1_789_000_000;
const CLOCK_MS = 1_790_000_000_000;
const NOW = 1_790_500_000;

interface Ex {
  gen: number;
  level: number;
  money?: number;
  cls?: string;
  nullGen?: boolean;
  name?: string;
  realm?: string;
}
function ex(o: Ex): string {
  const text = buildWowSyncExport({
    generatedAt: o.gen,
    character: { name: o.name ?? "Ordo", realm: o.realm ?? "Firemaw", level: o.level, moneyCopper: o.money, class: o.cls, ...ERA },
  });
  return o.nullGen ? text.replace(/Generated: \d+/, "Generated: ?") : text;
}

/** Runs `fn` with a pinned wall clock; `tick(seconds)` advances it so each import gets a distinct, known imported_at. */
function withClock<T>(fn: (tick: (seconds: number) => void) => T): T {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  let ms = CLOCK_MS;
  try {
    return fn((s) => {
      ms += s * 1000;
      mock.timers.setTime(ms);
    });
  } finally {
    mock.timers.reset();
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// --- "latest" follows observation time ---------------------------------------------------------

test("[SYNTHETIC] whatever order three exports are imported in, the store reports the newest OBSERVATION as current", () => {
  const exports = [
    ex({ gen: GEN + 10, level: 5, money: 100 }),
    ex({ gen: GEN + 20, level: 10, money: 200 }),
    ex({ gen: GEN + 30, level: 15, money: 300 }),
  ];
  for (const order of permutations([0, 1, 2])) {
    withClock((tick) => {
      const store = new SqliteSnapshotStore(":memory:");
      try {
        for (const i of order) {
          store.importSnapshot(exports[i]);
          tick(10);
        }
        const c = store.getCharacter(KEY)!;
        const label = `import order ${order.join(",")}`;
        assert.equal(c.latestLevel, 15, label);
        assert.equal(c.latestMoneyCopper, 300, label);
        assert.equal(c.latestGeneratedAt, GEN + 30, label);
        assert.deepEqual(store.listSnapshots(KEY).map((s) => s.generatedAt), [GEN + 30, GEN + 20, GEN + 10], label);

        // The latest PAIR is the newest two observations, forward in time.
        const change = store.recentChanges("classic-era")[0];
        assert.equal(change.diff.level.from, 10, label);
        assert.equal(change.diff.level.to, 15, label);
        assert.equal(change.diff.moneyCopper.delta, 100, label);

        // ...and AccountFacts and AccountContext tell the same story.
        const facts = store.buildAccountFacts("classic-era", NOW);
        assert.deepEqual({ from: facts.recentChanges[0].fromLevel, to: facts.recentChanges[0].toLevel }, { from: 10, to: 15 }, label);
        const last = store.buildAccountContext(NOW).versions["classic-era"].characters[0].transitions.at(-1)!;
        assert.deepEqual({ from: last.fromLevel, to: last.toLevel }, { from: 10, to: 15 }, label);
        assert.equal(facts.gold.totalKnownCopper, 300, label);
        assert.equal(store.listVersions()[0].totalMoneyCopper, 300, label);
      } finally {
        store.close();
      }
    });
  }
});

test("[SYNTHETIC] store and AccountContext agree on the latest pair for every import order, including ties and a missing Generated value", () => {
  // Distinct levels identify each export. Two share a Generated timestamp
  // (different content), one has no Generated value at all (falls back to its import time).
  const specs: Ex[] = [
    { gen: GEN + 10, level: 2 },
    { gen: GEN + 10, level: 3 },
    { gen: GEN + 20, level: 4, nullGen: true },
    { gen: GEN + 30, level: 5 },
  ];
  const exports = specs.map(ex);
  for (const order of permutations([0, 1, 2, 3])) {
    withClock((tick) => {
      const store = new SqliteSnapshotStore(":memory:");
      try {
        for (const i of order) {
          store.importSnapshot(exports[i]);
          tick(1);
        }
        const label = `import order ${order.join(",")}`;
        const ctx = store.buildAccountContext(NOW).versions["classic-era"].characters[0];
        assert.equal(store.getCharacter(KEY)!.latestLevel, ctx.snapshotHistory.at(-1)!.level, label);
        const facts = store.buildAccountFacts("classic-era", NOW);
        const last = ctx.transitions.at(-1)!;
        assert.deepEqual(
          { from: facts.recentChanges[0].fromLevel, to: facts.recentChanges[0].toLevel },
          { from: last.fromLevel, to: last.toLevel },
          label,
        );
      } finally {
        store.close();
      }
    });
  }
});

test("[SYNTHETIC] a missing Generated value falls back to the import time for ordering", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN + 50, level: 2 }));
      tick(5);
      store.importSnapshot(ex({ gen: GEN, level: 3, nullGen: true })); // imported "now" (1.79e9 > GEN + 50)
      const c = store.getCharacter(KEY)!;
      assert.equal(c.latestLevel, 3);
      assert.equal(c.latestGeneratedAt, undefined, "no Generated value: nothing to fabricate");
      assert.equal(store.buildAccountContext(NOW).versions["classic-era"].characters[0].snapshotHistory.at(-1)!.level, 3);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] two different exports with the same Generated value are both kept; the later import is later", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN, level: 5, money: 100 }));
      tick(3);
      const second = store.importSnapshot(ex({ gen: GEN, level: 5, money: 300 }));
      assert.equal(second.isDuplicate, false, "different content is a real second observation");
      assert.equal(store.getCharacter(KEY)!.snapshotCount, 2);
      assert.equal(store.getCharacter(KEY)!.latestMoneyCopper, 300);
      assert.equal(second.diff?.moneyCopper.delta, 200);
      assert.equal(store.buildAccountContext(NOW).versions["classic-era"].characters[0].transitions.at(-1)!.goldDeltaCopper, 200);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] recent changes are ranked by when the change was OBSERVED, not when it was imported", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      // Ordo's change was observed LAST but imported FIRST.
      store.importSnapshot(ex({ name: "Ordo", gen: GEN + 10, level: 1 }));
      store.importSnapshot(ex({ name: "Ordo", gen: GEN + 900, level: 2 }));
      tick(1000);
      // Belle's change was observed earlier but imported later.
      store.importSnapshot(ex({ name: "Belle", gen: GEN + 20, level: 1 }));
      store.importSnapshot(ex({ name: "Belle", gen: GEN + 40, level: 2 }));
      const names = store.recentChanges("classic-era").map((c) => c.characterName);
      assert.deepEqual(names, ["Ordo", "Belle"]);
      assert.equal(store.recentChanges("classic-era")[0].observedAt, GEN + 900);
    } finally {
      store.close();
    }
  });
});

// --- Out-of-order import results ---------------------------------------------------------------

test("[SYNTHETIC] importing an OLDER export later is reported as history, never as a reversed change, and does not become current", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const newer = store.importSnapshot(ex({ gen: GEN + 20, level: 10, money: 1000, cls: "Mage" }));
      assert.equal(newer.isFirstSnapshot, true);
      assert.equal(newer.isLatest, true);
      tick(10);

      const older = store.importSnapshot(ex({ gen: GEN + 10, level: 5, money: 500, cls: "Warrior" }));
      assert.equal(older.isDuplicate, false);
      assert.equal(older.isLatest, false, "the current state is still the newer observation");
      assert.equal(older.isFirstSnapshot, false, "the character already had history");
      assert.equal(older.previousSnapshot, undefined, "nothing older to compare against");
      assert.equal(older.diff, undefined, "no comparison exists - not a reversed one, and not 'no changes'");
      assert.equal(older.character.latestLevel, 10);
      assert.equal(older.character.latestMoneyCopper, 1000);
      assert.equal(older.character.class, "Mage", "an older export must not overwrite newer class/faction");
      assert.equal(older.character.snapshotCount, 2);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] an export that lands in the MIDDLE of history is diffed against its chronological predecessor, forward in time", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN + 10, level: 5, money: 100 }));
      tick(1);
      store.importSnapshot(ex({ gen: GEN + 30, level: 15, money: 900 }));
      tick(1);
      const middle = store.importSnapshot(ex({ gen: GEN + 20, level: 10, money: 400 }));
      assert.equal(middle.isLatest, false);
      assert.equal(middle.isFirstSnapshot, false);
      assert.equal(middle.previousSnapshot?.generatedAt, GEN + 10);
      assert.equal(middle.diff?.level.delta, 5);
      assert.equal(middle.diff?.moneyCopper.delta, 300);
      assert.equal(middle.character.latestLevel, 15);

      tick(1);
      const newest = store.importSnapshot(ex({ gen: GEN + 40, level: 20, money: 1000 }));
      assert.equal(newest.isLatest, true);
      assert.equal(newest.previousSnapshot?.generatedAt, GEN + 30);
      assert.equal(newest.diff?.level.delta, 5);
    } finally {
      store.close();
    }
  });
});

// --- Idempotent re-import ------------------------------------------------------------------------

test("[REAL] re-importing an identical export changes nothing and does not erase the real Bromrik transition", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const a = read("classic-era/bromrik-1789170870.wowsync.txt");
      const b = read("classic-era/bromrik-1789171621.wowsync.txt");
      store.importSnapshot(a);
      tick(5);
      const second = store.importSnapshot(b);
      tick(5);
      const changesBefore = JSON.stringify(store.recentChanges("classic-era"));
      const contextBefore = JSON.stringify(store.buildAccountContext(NOW));
      const key = second.character.identityKey;
      assert.equal(second.diff?.level.delta, 1);

      const again = store.importSnapshot(b);
      assert.equal(again.isDuplicate, true);
      assert.equal(again.isFirstSnapshot, false);
      assert.equal(again.snapshot.id, second.snapshot.id, "reports the EXISTING snapshot");
      assert.equal(again.diff, undefined, "a duplicate is not presented as a new comparison");
      assert.equal(again.previousSnapshot, undefined);
      assert.equal(again.character.snapshotCount, 2, "no fake history");
      assert.equal(store.listSnapshots(key).length, 2);

      assert.equal(JSON.stringify(store.recentChanges("classic-era")), changesBefore, "the real +1 level transition is still the latest one");
      assert.equal(store.recentChanges("classic-era")[0].diff.level.delta, 1);
      assert.equal(JSON.stringify(store.buildAccountContext(NOW)), contextBefore);
    } finally {
      store.close();
    }
  });
});

test("[REAL] re-importing an OLDER identical export is also a no-op, and the newer snapshot stays current", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const a = read("classic-era/bromrik-1789170870.wowsync.txt");
      const b = read("classic-era/bromrik-1789171621.wowsync.txt");
      store.importSnapshot(a);
      tick(5);
      store.importSnapshot(b);
      tick(5);
      const dup = store.importSnapshot(a);
      assert.equal(dup.isDuplicate, true);
      assert.equal(dup.character.snapshotCount, 2);
      assert.equal(dup.character.latestLevel, 4);
      assert.equal(dup.character.latestMoneyCopper, 304);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] the first-ever import twice: the first is first, the second is a duplicate of it", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const text = ex({ gen: GEN, level: 5, money: 100 });
      const first = store.importSnapshot(text);
      assert.equal(first.isFirstSnapshot, true);
      assert.equal(first.isDuplicate, false);
      tick(5);
      const second = store.importSnapshot(text);
      assert.equal(second.isDuplicate, true);
      assert.equal(second.isFirstSnapshot, false);
      assert.equal(second.character.snapshotCount, 1);
      assert.equal(second.character.latestImportedAt, first.character.latestImportedAt, "a duplicate does not refresh anything");
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] copy/paste whitespace differences (CRLF line endings, trailing newlines) do not defeat duplicate detection, and the stored text is left verbatim", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const text = ex({ gen: GEN, level: 5, money: 100 });
      const first = store.importSnapshot(text);
      const crlf = store.importSnapshot(text.replace(/\n/g, "\r\n"));
      const trailing = store.importSnapshot(text + "\n\n  \n");
      assert.equal(crlf.isDuplicate, true);
      assert.equal(trailing.isDuplicate, true);
      assert.equal(store.getCharacter(KEY)!.snapshotCount, 1);
      assert.equal(store.getSnapshot(first.snapshot.id)!.parsed.raw, text, "raw export is stored unnormalised");
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] the same Generated value with a DIFFERENT export is never treated as a duplicate (that would silently delete history)", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const a = store.importSnapshot(ex({ gen: GEN, level: 5, money: 100 }));
      const b = store.importSnapshot(ex({ gen: GEN, level: 5, money: 101 }));
      const c = store.importSnapshot(ex({ gen: GEN, level: 6, money: 101 }));
      assert.deepEqual([a.isDuplicate, b.isDuplicate, c.isDuplicate], [false, false, false]);
      assert.equal(store.getCharacter(KEY)!.snapshotCount, 3);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] identical content on a DIFFERENT character is not a duplicate (identity scopes it)", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN, level: 5, money: 100, name: "Ordo" }));
      const other = store.importSnapshot(ex({ gen: GEN, level: 5, money: 100, name: "Belle" }));
      assert.equal(other.isDuplicate, false);
      assert.equal(store.listCharacters("classic-era").length, 2);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] deleting a character does not leave a tombstone: the same export can be imported again as a fresh history", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const text = ex({ gen: GEN, level: 5, money: 100 });
      store.importSnapshot(text);
      store.deleteCharacter(KEY);
      const again = store.importSnapshot(text);
      assert.equal(again.isDuplicate, false);
      assert.equal(again.isFirstSnapshot, true);
      assert.equal(again.character.snapshotCount, 1);
    } finally {
      store.close();
    }
  });
});

// --- Atomic import ----------------------------------------------------------------------------------

test("[SYNTHETIC] a failure while inserting the snapshot leaves NO ghost character behind (import is atomic)", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const stmts = (store as unknown as { stmts: Record<string, unknown> }).stmts;
      const realInsert = stmts.insertSnapshot;
      stmts.insertSnapshot = {
        run() {
          throw new Error("disk full (simulated)");
        },
      };
      assert.throws(() => store.importSnapshot(ex({ gen: GEN, level: 5, money: 100 })), /disk full/);
      assert.deepEqual(store.listCharacters("classic-era"), [], "no character row without a snapshot");
      assert.equal(store.listVersions().length, 0);

      // The store is usable afterwards (no dangling open transaction).
      stmts.insertSnapshot = realInsert;
      assert.equal(store.importSnapshot(ex({ gen: GEN, level: 5, money: 100 })).character.snapshotCount, 1);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] a failed import for an EXISTING character rolls back its class/faction update too", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN, level: 5, cls: "Mage" }));
      tick(1);
      const stmts = (store as unknown as { stmts: Record<string, unknown> }).stmts;
      stmts.insertSnapshot = {
        run() {
          throw new Error("boom");
        },
      };
      assert.throws(() => store.importSnapshot(ex({ gen: GEN + 10, level: 6, cls: "Warrior" })), /boom/);
      assert.equal(store.getCharacter(KEY)!.class, "Mage");
      assert.equal(store.getCharacter(KEY)!.snapshotCount, 1);
    } finally {
      store.close();
    }
  });
});

// --- Existing databases ---------------------------------------------------------------------------------

test("[SYNTHETIC] no migration: a database file written earlier reopens and orders by observation time without any schema change", () => {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-order-"));
  const path = join(folder, "old.sqlite");
  try {
    withClock((tick) => {
      const first = new SqliteSnapshotStore(path);
      first.importSnapshot(ex({ gen: GEN + 20, level: 10 }));
      tick(5);
      first.importSnapshot(ex({ gen: GEN + 10, level: 5 })); // an old-style out-of-order history
      first.close();

      const reopened = new SqliteSnapshotStore(path);
      const again = new SqliteSnapshotStore(path); // a second open must not fail on any schema step
      try {
        assert.equal(reopened.getCharacter(KEY)!.latestLevel, 10);
        assert.equal(reopened.getCharacter(KEY)!.snapshotCount, 2);
        assert.deepEqual(reopened.listSnapshots(KEY).map((s) => s.generatedAt), [GEN + 20, GEN + 10]);
      } finally {
        again.close();
        reopened.close();
      }
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// --- A bad clock cannot pin "latest" ---------------------------------------------------------------

test("[SYNTHETIC] an export whose Generated value is in the FUTURE (bad clock) cannot outrank real exports imported afterwards", () => {
  const FUTURE = 4_000_000_000; // year 2096
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: GEN, level: 5, money: 100 }));
      tick(10);
      const bad = store.importSnapshot(ex({ gen: FUTURE, level: 6, money: 111 }));
      assert.equal(bad.isLatest, true, "the newest thing we have seen so far");
      tick(300);
      // A real export: generated seconds BEFORE it was imported, and after the bad one was imported.
      const real = store.importSnapshot(ex({ gen: CLOCK_MS / 1000 + 290, level: 7, money: 999_999 }));
      assert.equal(real.isLatest, true, "a real, later export must become current");
      assert.equal(real.character.latestLevel, 7);
      assert.equal(real.character.latestMoneyCopper, 999_999);
      assert.equal(real.previousSnapshot?.generatedAt, FUTURE, "the bad-clock export is chronologically before it (observed no later than it was imported)");
      // AccountContext agrees with the store.
      assert.equal(store.buildAccountContext(NOW).versions["classic-era"].characters[0].snapshotHistory.at(-1)!.level, 7);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] a lone future-dated snapshot is observed no later than it was imported - it does not read as 'recent' forever", () => {
  withClock(() => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      store.importSnapshot(ex({ gen: 4_000_000_000, level: 5, money: 100 }));
      const later = CLOCK_MS / 1000 + 30 * 86400; // a month after the import
      const facts = store.buildAccountFacts("classic-era", later);
      assert.equal(facts.characters[0].lastObservedAt, CLOCK_MS / 1000, "clamped to the import time");
      assert.equal(facts.characters[0].freshness, "stale");
      assert.equal(facts.gold.staleCharactersWithKnownGold, 1);
      assert.equal(facts.gold.oldestKnownGoldObservedAt, CLOCK_MS / 1000);
    } finally {
      store.close();
    }
  });
});

test("[SYNTHETIC] normal exports (Generated slightly BEFORE the import, as the real data always is) are unaffected by the clamp", () => {
  withClock((tick) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const importedAt = CLOCK_MS / 1000;
      store.importSnapshot(ex({ gen: importedAt - 20, level: 5 }));
      tick(60);
      store.importSnapshot(ex({ gen: importedAt + 40, level: 6 }));
      assert.equal(store.getCharacter(KEY)!.latestGeneratedAt, importedAt + 40);
      assert.equal(store.buildAccountFacts("classic-era", importedAt + 100).characters[0].lastObservedAt, importedAt + 40);
    } finally {
      store.close();
    }
  });
});
