// End-to-end sanity check against saved fixture files (not the in-memory
// builder) — this is closer to what actually happens when a user pastes a
// .txt export into the app. Uses REAL gameplay fixtures throughout:
// Classic Era (Bromrik), Retail (Ezaller), and TBC Anniversary
// (Torahn/Voodan/Tenivard, all on Dreamscythe).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

test("[REAL] Bromrik's two real snapshots import cleanly and produce the expected Classic Era diff", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const first = store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    assert.equal(first.character.version, "classic-era");
    assert.equal(first.isFirstSnapshot, true);

    const second = store.importSnapshot(read("classic-era/bromrik-1789171621.wowsync.txt"));
    assert.equal(second.isFirstSnapshot, false);
    assert.equal(second.diff?.level.delta, 1);
    assert.equal(second.diff?.moneyCopper.delta, 304 - 114);

    const chars = store.listCharacters("classic-era");
    assert.equal(chars.length, 1);
    assert.equal(chars[0].snapshotCount, 2);
  } finally {
    store.close();
  }
});

test("[REAL] Ezaller's two real snapshots import cleanly and produce the expected Retail diff", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
    const second = store.importSnapshot(read("retail/ezaller-1789478317.wowsync.txt"));

    assert.equal(second.character.version, "retail");
    assert.equal(second.diff?.moneyCopper.delta, 24_797_508 - 24_205_308);
    assert.equal(second.diff?.playedSeconds.delta, 12_638 - 12_573);
    assert.equal(second.diff?.levelPlayedSeconds.delta, 694 - 629);
  } finally {
    store.close();
  }
});

test("[REAL] Bromrik (Classic Era) and Ezaller (Retail) land in isolated version spaces", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));

    const era = store.listCharacters("classic-era");
    const retail = store.listCharacters("retail");
    assert.equal(era.length, 1);
    assert.equal(era[0].name, "Bromrik");
    assert.equal(retail.length, 1);
    assert.equal(retail[0].name, "Ezaller");

    const eraVersion = store.listVersions().find((v) => v.version === "classic-era")!;
    const retailVersion = store.listVersions().find((v) => v.version === "retail")!;
    assert.equal(eraVersion.totalMoneyCopper, 114);
    assert.equal(retailVersion.totalMoneyCopper, 24_205_308);
  } finally {
    store.close();
  }
});

test("[REAL] the full real TBC Anniversary Dreamscythe roster imports cleanly and stays isolated from Classic Era/Retail", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
    store.importSnapshot(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
    store.importSnapshot(read("tbc-anniversary/voodan-1789492666.wowsync.txt"));
    store.importSnapshot(read("tbc-anniversary/torahn-1789492498.wowsync.txt"));
    store.importSnapshot(read("tbc-anniversary/tenivard-1789492580.wowsync.txt"));

    const tbc = store.listCharacters("tbc-anniversary");
    assert.equal(tbc.length, 3);
    const byName = new Map(tbc.map((c) => [c.name, c]));
    assert.equal(byName.get("Voodan")?.snapshotCount, 2);
    assert.equal(byName.get("Torahn")?.snapshotCount, 1);
    assert.equal(byName.get("Tenivard")?.snapshotCount, 1);
    assert.ok(tbc.every((c) => c.realm === "Dreamscythe"));

    // Real version spaces are untouched by the TBC roster.
    assert.equal(store.listCharacters("classic-era").length, 1);
    assert.equal(store.listCharacters("retail").length, 1);
  } finally {
    store.close();
  }
});
