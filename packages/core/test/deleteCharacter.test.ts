// Character deletion: removes one character and its entire snapshot
// history, and every derived view (AccountFacts, AccountContext, recent
// changes, inventory/profession aggregation, freshness, the LLM payload)
// reflects it automatically because those are all computed from the
// remaining rows. Real fixtures throughout; the few synthetic cases are
// labelled.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { searchInventory } from "../src/accountFacts.ts";
import { buildLlmContext } from "../src/llmContext.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const NOW = 1_800_000_000;

const VOODAN = "tbc-anniversary::dreamscythe::voodan"; // 2 real snapshots
const TORAHN = "tbc-anniversary::dreamscythe::torahn"; // 1 real snapshot
const TENIVARD = "tbc-anniversary::dreamscythe::tenivard"; // 1 real snapshot
const BROMRIK = "classic-era::defias pillager::bromrik"; // 2 real snapshots
const EZALLER = "retail::kel'thuzad::ezaller"; // 2 real snapshots
const HALLO = "forever::classic beta pvp 2::hallo emberstone"; // 2 real snapshots

function seed(store: SqliteSnapshotStore, which: ("voodan" | "torahn" | "tenivard" | "bromrik" | "ezaller" | "hallo")[] = ["voodan", "torahn", "tenivard", "bromrik", "ezaller", "hallo"]) {
  const files: Record<string, string[]> = {
    voodan: ["tbc-anniversary/voodan-1789484723.wowsync.txt", "tbc-anniversary/voodan-1789492666.wowsync.txt"],
    torahn: ["tbc-anniversary/torahn-1789492498.wowsync.txt"],
    tenivard: ["tbc-anniversary/tenivard-1789492580.wowsync.txt"],
    bromrik: ["classic-era/bromrik-1789170870.wowsync.txt", "classic-era/bromrik-1789171621.wowsync.txt"],
    ezaller: ["retail/ezaller-1789477879.wowsync.txt", "retail/ezaller-1789478317.wowsync.txt"],
    hallo: ["forever/hallo-1789693144.wowsync.txt", "forever/hallo-1789731867.wowsync.txt"],
  };
  for (const name of which) for (const file of files[name]) store.importSnapshot(read(file));
}

/** A file-backed store plus a second raw connection, so tests can look at the actual tables (e.g. for orphaned rows). */
function fileStore() {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-delete-"));
  const path = join(folder, "test.sqlite");
  const store = new SqliteSnapshotStore(path);
  const raw = new DatabaseSync(path);
  const count = (sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);
  return {
    store,
    raw,
    counts: () => ({
      characters: count("SELECT COUNT(*) AS n FROM characters"),
      snapshots: count("SELECT COUNT(*) AS n FROM snapshots"),
      orphanSnapshots: count("SELECT COUNT(*) AS n FROM snapshots WHERE character_id NOT IN (SELECT id FROM characters)"),
    }),
    cleanup() {
      raw.close();
      store.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

// --- Basic deletion --------------------------------------------------------------

test("[REAL] deleting a character with multiple snapshots removes the character and every snapshot, leaving no orphans", () => {
  const h = fileStore();
  try {
    seed(h.store);
    assert.deepEqual(h.counts(), { characters: 6, snapshots: 10, orphanSnapshots: 0 });

    const result = h.store.deleteCharacter(VOODAN);
    assert.deepEqual(result, {
      identityKey: VOODAN,
      version: "tbc-anniversary",
      realm: "Dreamscythe",
      name: "Voodan",
      snapshotsDeleted: 2,
    });

    assert.equal(h.store.getCharacter(VOODAN), undefined);
    assert.deepEqual(h.store.listSnapshots(VOODAN), []);
    assert.deepEqual(h.counts(), { characters: 5, snapshots: 8, orphanSnapshots: 0 });
  } finally {
    h.cleanup();
  }
});

test("[REAL] deleting a character with a single snapshot works", () => {
  const h = fileStore();
  try {
    seed(h.store);
    const result = h.store.deleteCharacter(TENIVARD);
    assert.equal(result?.snapshotsDeleted, 1);
    assert.equal(result?.name, "Tenivard");
    assert.equal(h.store.getCharacter(TENIVARD), undefined);
    assert.deepEqual(h.counts(), { characters: 5, snapshots: 9, orphanSnapshots: 0 });
  } finally {
    h.cleanup();
  }
});

test("[REAL] deleting the only character in a version leaves that version empty, not missing", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["hallo"]);
    assert.equal(store.listVersions().find((v) => v.version === "forever")?.characterCount, 1);
    store.deleteCharacter(HALLO);
    assert.equal(store.listVersions().find((v) => v.version === "forever"), undefined, "no characters -> no version summary row");
    assert.deepEqual(store.listCharacters("forever"), []);
    assert.equal(store.buildAccountFacts("forever", NOW).characterCount, 0);
    assert.equal(store.buildAccountContext(NOW).versions["forever"].characters.length, 0);
  } finally {
    store.close();
  }
});

test("[REAL] a deleted character can be re-imported cleanly and starts a fresh history", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["hallo"]);
    store.deleteCharacter(HALLO);
    const again = store.importSnapshot(read("forever/hallo-1789731867.wowsync.txt"));
    assert.equal(again.isFirstSnapshot, true);
    assert.equal(again.previousSnapshot, undefined);
    assert.equal(again.diff, undefined);
    assert.equal(again.character.snapshotCount, 1);
  } finally {
    store.close();
  }
});

// --- Isolation: other characters, other versions -----------------------------------

test("[REAL] deleting one character leaves the other characters (same realm) and their history untouched", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store);
    const before = {
      torahn: store.listSnapshots(TORAHN),
      tenivard: store.listSnapshots(TENIVARD),
      torahnSummary: store.getCharacter(TORAHN),
    };
    store.deleteCharacter(VOODAN);
    assert.deepEqual(store.listSnapshots(TORAHN), before.torahn);
    assert.deepEqual(store.listSnapshots(TENIVARD), before.tenivard);
    assert.deepEqual(store.getCharacter(TORAHN), before.torahnSummary);
    assert.deepEqual(
      store.listCharacters("tbc-anniversary").map((c) => c.name),
      ["Tenivard", "Torahn"],
    );
  } finally {
    store.close();
  }
});

test("[REAL] deletion is version-isolated: other versions are untouched, and an identically named character in another version survives", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store);
    // Same name + same realm text as the Forever Hallo, but a Classic Era character.
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Hallo Emberstone", realm: "Classic Beta PvP 2", level: 20, moneyCopper: 999, clientVersion: "1.15.9", clientBuild: "69547" },
      }),
    );
    const twinKey = "classic-era::classic beta pvp 2::hallo emberstone";
    const eraBefore = store.buildAccountFacts("classic-era", NOW);
    const retailBefore = store.buildAccountFacts("retail", NOW);
    const tbcBefore = store.buildAccountFacts("tbc-anniversary", NOW);

    store.deleteCharacter(HALLO);

    assert.equal(store.getCharacter(HALLO), undefined);
    assert.equal(store.getCharacter(twinKey)?.latestMoneyCopper, 999);
    assert.equal(store.buildAccountFacts("forever", NOW).characterCount, 0);
    assert.deepEqual(store.buildAccountFacts("classic-era", NOW), eraBefore);
    assert.deepEqual(store.buildAccountFacts("retail", NOW), retailBefore);
    assert.deepEqual(store.buildAccountFacts("tbc-anniversary", NOW), tbcBefore);
  } finally {
    store.close();
  }
});

test("[REAL] deleting a Classic Era or Retail character works across versions and touches nothing else", () => {
  const h = fileStore();
  try {
    seed(h.store);
    assert.equal(h.store.deleteCharacter(BROMRIK)?.version, "classic-era");
    assert.equal(h.store.deleteCharacter(EZALLER)?.version, "retail");
    assert.deepEqual(h.store.listCharacters("classic-era"), []);
    assert.deepEqual(h.store.listCharacters("retail"), []);
    assert.equal(h.store.listCharacters("tbc-anniversary").length, 3);
    assert.equal(h.store.listCharacters("forever").length, 1);
    assert.deepEqual(h.counts(), { characters: 4, snapshots: 6, orphanSnapshots: 0 });
  } finally {
    h.cleanup();
  }
});

// --- Derived views reflect the deletion ---------------------------------------------

test("[REAL] AccountFacts after deletion: gold, playtime, progression, freshness, realms, inventory and profession coverage all drop the deleted character", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["voodan", "torahn", "tenivard"]);
    const before = store.buildAccountFacts("tbc-anniversary", NOW);
    const voodanBefore = before.characters.find((c) => c.name === "Voodan")!;
    assert.ok(voodanBefore.goldCopper !== undefined);

    store.deleteCharacter(VOODAN);
    const after = store.buildAccountFacts("tbc-anniversary", NOW);

    assert.deepEqual(after.characters.map((c) => c.name).sort(), ["Tenivard", "Torahn"]);
    assert.equal(after.characterCount, 2);
    assert.equal(after.gold.totalKnownCopper, before.gold.totalKnownCopper - voodanBefore.goldCopper!);
    assert.equal(after.gold.byCharacter.some((g) => g.name === "Voodan"), false);
    assert.equal(after.playtime.byCharacter.some((p) => p.name === "Voodan"), false);
    assert.equal(after.progression.byCharacter.some((p) => p.name === "Voodan"), false);
    assert.equal(after.progression.recentLevelUps.some((l) => l.name === "Voodan"), false);
    assert.equal(after.freshness.byCharacter.some((f) => f.name === "Voodan"), false);
    assert.equal(
      after.freshness.recentCharacters + after.freshness.staleCharacters + after.freshness.unknownCharacters,
      2,
    );
    assert.equal(after.realms.length, 1);
    assert.equal(after.realms[0].characterCount, 2);
    assert.equal(after.realms[0].gold.totalKnownCopper, after.gold.totalKnownCopper);

    const holders = (facts: typeof after) =>
      facts.inventory.items.flatMap((i) => i.locations).filter((l) => l.name === "Voodan");
    assert.ok(holders(before).length > 0, "Voodan had real bag items before");
    assert.equal(holders(after).length, 0);
    assert.equal(after.inventory.unknownBank.some((u) => u.name === "Voodan"), false);
    assert.equal(after.inventory.unknownBags.some((u) => u.name === "Voodan"), false);
    // Items only Voodan held are gone entirely, not left as zero-quantity ghosts.
    const onlyVoodan = before.inventory.items.filter((i) => i.locations.every((l) => l.name === "Voodan"));
    assert.ok(onlyVoodan.length > 0);
    for (const item of onlyVoodan) {
      assert.equal(after.inventory.items.some((i) => i.itemKey === item.itemKey), false);
    }

    assert.equal(after.professions.byCharacter.some((p) => p.name === "Voodan"), false);
    for (const entry of after.professions.coverage) {
      assert.equal(entry.characters.some((c) => c.name === "Voodan"), false);
    }
  } finally {
    store.close();
  }
});

test("[REAL] deleting the only holder of a profession moves its coverage away from 'covered', and never to a false 'none' while an unobserved character remains", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["voodan", "tenivard"]);
    const before = store.buildAccountFacts("tbc-anniversary", NOW).professions;
    const voodanProfessions = before.byCharacter.find((p) => p.name === "Voodan")!.professions.map((p) => p.name);
    assert.ok(voodanProfessions.length > 0);
    const tenivardProfessions = before.byCharacter.find((p) => p.name === "Tenivard")!.professions.map((p) => p.name);
    const soleHeld = voodanProfessions.find((p) => !tenivardProfessions.includes(p));
    assert.ok(soleHeld, "Voodan holds a profession Tenivard does not");
    assert.equal(before.coverage.find((c) => c.profession === soleHeld)?.coverageStatus, "covered");

    store.deleteCharacter(VOODAN);
    const after = store.buildAccountFacts("tbc-anniversary", NOW).professions;
    const status = after.coverage.find((c) => c.profession === soleHeld)?.coverageStatus;
    const tenivardObserved = after.byCharacter.find((p) => p.name === "Tenivard")!.observationStatus;
    // The remaining roster's own observation state decides none-vs-unknown - never "covered" by a deleted character.
    assert.equal(status, tenivardObserved === "UNKNOWN" ? "unknown" : "none");
    assert.equal(after.coverage.find((c) => c.profession === soleHeld)?.characters.length, 0);
  } finally {
    store.close();
  }
});

test("[REAL] recent changes after deletion no longer include the deleted character (version listing and AccountFacts)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["voodan", "torahn"]);
    assert.equal(store.recentChanges("tbc-anniversary").some((c) => c.identityKey === VOODAN), true);
    assert.equal(store.buildAccountFacts("tbc-anniversary", NOW).recentChanges.some((c) => c.identityKey === VOODAN), true);

    store.deleteCharacter(VOODAN);
    assert.deepEqual(store.recentChanges("tbc-anniversary"), []);
    assert.deepEqual(store.buildAccountFacts("tbc-anniversary", NOW).recentChanges, []);
  } finally {
    store.close();
  }
});

test("[REAL] inventory search and version summaries after deletion no longer see the deleted character's holdings", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store, ["voodan", "tenivard"]);
    const facts = store.buildAccountFacts("tbc-anniversary", NOW);
    const held = facts.inventory.items.find((i) => i.locations.every((l) => l.name === "Voodan") && i.name);
    assert.ok(held?.name);
    assert.ok(searchInventory(facts.inventory, held!.name!).length > 0);

    store.deleteCharacter(VOODAN);
    const after = store.buildAccountFacts("tbc-anniversary", NOW);
    assert.deepEqual(searchInventory(after.inventory, held!.name!), []);

    const summary = store.listVersions().find((v) => v.version === "tbc-anniversary")!;
    assert.equal(summary.characterCount, 1);
    assert.equal(summary.totalMoneyCopper, after.gold.totalKnownCopper);
  } finally {
    store.close();
  }
});

test("[REAL] AccountContext and the Ask-My-Account LLM payload after deletion contain no trace of the deleted character", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seed(store);
    store.deleteCharacter(VOODAN);
    const ctx = store.buildAccountContext(NOW);
    const llm = buildLlmContext(ctx);

    assert.deepEqual(ctx.versions["tbc-anniversary"].characters.map((c) => c.name), ["Tenivard", "Torahn"]);
    assert.equal(ctx.versions["tbc-anniversary"].facts.characterCount, 2);
    assert.equal(JSON.stringify(ctx).toLowerCase().includes("voodan"), false, "not even in embedded facts, transitions, or inventory");
    assert.equal(JSON.stringify(llm).toLowerCase().includes("voodan"), false);

    const index = llm.latestTransitionIndex;
    for (const list of [index.comparable, index.insufficientHistory, index.goldChanged, index.inventoryChanged, index.levelChanged, index.playtimeChanged]) {
      assert.equal(list.includes(VOODAN), false);
    }
    // The other characters, including Forever's Hallo, are still fully present.
    assert.equal(ctx.versions["forever"].characters[0].name, "Hallo Emberstone");
    assert.equal(ctx.versions["forever"].characters[0].snapshotHistory.length, 2);
  } finally {
    store.close();
  }
});

test("[REAL] a store after deleting X is indistinguishable from one that never imported X (full AccountContext, byte-identical)", () => {
  // importedAt comes from the wall clock; pin it so both stores agree.
  mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
  try {
    const withDeletion = new SqliteSnapshotStore(":memory:");
    const never = new SqliteSnapshotStore(":memory:");
    try {
      seed(withDeletion);
      withDeletion.deleteCharacter(VOODAN);
      withDeletion.deleteCharacter(HALLO);
      seed(never, ["torahn", "tenivard", "bromrik", "ezaller"]);
      assert.equal(JSON.stringify(withDeletion.buildAccountContext(NOW)), JSON.stringify(never.buildAccountContext(NOW)));
      assert.equal(
        JSON.stringify(buildLlmContext(withDeletion.buildAccountContext(NOW))),
        JSON.stringify(buildLlmContext(never.buildAccountContext(NOW))),
      );
    } finally {
      withDeletion.close();
      never.close();
    }
  } finally {
    mock.timers.reset();
  }
});

// --- Nonexistent / malformed keys ------------------------------------------------------

test("deleting a nonexistent or already-deleted character is a safe no-op that returns undefined", () => {
  const h = fileStore();
  try {
    seed(h.store);
    const before = h.counts();
    assert.equal(h.store.deleteCharacter("tbc-anniversary::dreamscythe::nobody"), undefined);
    assert.equal(h.store.deleteCharacter(VOODAN)?.snapshotsDeleted, 2);
    assert.equal(h.store.deleteCharacter(VOODAN), undefined, "second delete of the same key");
    assert.deepEqual(h.counts(), { characters: before.characters - 1, snapshots: before.snapshots - 2, orphanSnapshots: 0 });
  } finally {
    h.cleanup();
  }
});

test("[SYNTHETIC] malformed keys never match anything: empty, whitespace, wrong case, SQL wildcards, and injection-shaped strings delete nothing", () => {
  const h = fileStore();
  try {
    seed(h.store);
    const before = h.counts();
    for (const bad of [
      "",
      "   ",
      "%",
      "_",
      "%::%::%",
      "tbc-anniversary::dreamscythe::%",
      VOODAN.toUpperCase(), // identity keys are stored lowercased; exact match only
      ` ${VOODAN}`,
      `${VOODAN} `,
      "x'; DELETE FROM characters; --",
      "voodan",
      "tbc-anniversary::dreamscythe::voodan::extra",
    ]) {
      assert.equal(h.store.deleteCharacter(bad), undefined, `key ${JSON.stringify(bad)} must not match`);
    }
    assert.deepEqual(h.counts(), before);
    assert.equal(h.store.listCharacters("tbc-anniversary").length, 3);
  } finally {
    h.cleanup();
  }
});

test("[SYNTHETIC] the unrouted (unknown-version) quarantine can be cleaned up like any other character", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const imported = store.importSnapshot(
      buildWowSyncExport({ character: { name: "Mystery", realm: "Nowhere", clientVersion: "9.9.9", clientBuild: "1" } }),
    );
    assert.equal(imported.character.version, "unknown-version");
    assert.equal(store.deleteCharacter(imported.character.identityKey)?.snapshotsDeleted, 1);
    assert.deepEqual(store.listCharacters("unknown-version"), []);
  } finally {
    store.close();
  }
});

// --- Integrity ------------------------------------------------------------------------------

test("[SYNTHETIC] deletion is atomic: if removing the character row fails, the snapshots are rolled back too", () => {
  const h = fileStore();
  try {
    seed(h.store, ["voodan", "torahn"]);
    const before = h.counts();
    // A second connection installs a trigger that vetoes deleting Voodan's character row.
    h.raw.exec(`CREATE TRIGGER veto BEFORE DELETE ON characters WHEN OLD.identity_key = '${VOODAN}'
                BEGIN SELECT RAISE(ABORT, 'delete vetoed'); END;`);

    assert.throws(() => h.store.deleteCharacter(VOODAN), /delete vetoed/);
    assert.deepEqual(h.counts(), before, "snapshots deleted earlier in the transaction were rolled back");
    assert.equal(h.store.getCharacter(VOODAN)?.snapshotCount, 2);

    // The store is still usable (no dangling open transaction), and other deletions still work.
    assert.equal(h.store.deleteCharacter(TORAHN)?.snapshotsDeleted, 1);
    h.raw.exec("DROP TRIGGER veto");
    assert.equal(h.store.deleteCharacter(VOODAN)?.snapshotsDeleted, 2);
    assert.deepEqual(h.counts(), { characters: 0, snapshots: 0, orphanSnapshots: 0 });
  } finally {
    h.cleanup();
  }
});
