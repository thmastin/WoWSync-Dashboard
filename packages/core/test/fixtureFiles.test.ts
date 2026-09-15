// End-to-end sanity check against saved fixture files (not the in-memory
// builder) — this is closer to what actually happens when a user pastes a
// .txt export into the app. Uses REAL gameplay fixtures for Classic Era
// (Bromrik) and Retail (Ezaller); TBC Anniversary uses the labeled
// synthetic placeholder pending real captures (see fixtures/README.md).
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

test("[SYNTHETIC placeholder] the TBC Anniversary placeholder stays isolated from the real Classic Era/Retail data", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-1789170870.wowsync.txt"));
    store.importSnapshot(read("retail/ezaller-1789477879.wowsync.txt"));
    store.importSnapshot(read("synthetic/tbc-anniversary-placeholder-01.txt"));
    store.importSnapshot(read("synthetic/tbc-anniversary-placeholder-02.txt"));

    const tbc = store.listCharacters("tbc-anniversary");
    assert.equal(tbc.length, 1);
    assert.equal(tbc[0].name, "Synthtest");
    assert.equal(tbc[0].snapshotCount, 2);

    // Real version spaces are untouched by the synthetic placeholder.
    assert.equal(store.listCharacters("classic-era").length, 1);
    assert.equal(store.listCharacters("retail").length, 1);
  } finally {
    store.close();
  }
});
