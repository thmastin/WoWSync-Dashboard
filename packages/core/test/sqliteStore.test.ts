import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

function freshStore() {
  return new SqliteSnapshotStore(":memory:");
}

test("importing an export creates a character and a first snapshot", () => {
  const store = freshStore();
  try {
    const raw = buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 } });
    const result = store.importSnapshot(raw);
    assert.equal(result.isFirstSnapshot, true);
    assert.equal(result.character.name, "Torahn");
    assert.equal(result.character.version, "tbc-anniversary");
    assert.equal(result.character.snapshotCount, 1);
    assert.equal(result.diff, undefined);
  } finally {
    store.close();
  }
});

test("a second import does not destroy the first snapshot, and produces a diff", () => {
  const store = freshStore();
  try {
    const raw1 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 20, moneyCopper: 50000 },
      professions: { entries: [{ name: "Mining", skill: 60, maxSkill: 300 }] },
    });
    const raw2 = buildWowSyncExport({
      character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", level: 22, moneyCopper: 70000 },
      professions: { entries: [{ name: "Mining", skill: 74, maxSkill: 300 }] },
    });
    store.importSnapshot(raw1);
    const result2 = store.importSnapshot(raw2);

    assert.equal(result2.isFirstSnapshot, false);
    assert.equal(result2.character.snapshotCount, 2);
    assert.equal(result2.diff?.level.delta, 2);
    assert.equal(result2.diff?.moneyCopper.delta, 20000);
    assert.equal(result2.diff?.professions[0]?.skill.delta, 14);

    const history = store.listSnapshots(result2.character.identityKey);
    assert.equal(history.length, 2);
    assert.equal(history[0].parsed.character.level, 22);
    assert.equal(history[1].parsed.character.level, 20);
  } finally {
    store.close();
  }
});

test("characters in different WoW versions are never aggregated together", () => {
  const store = freshStore();
  try {
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7", moneyCopper: 10000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6", moneyCopper: 700000 } }),
    );
    store.importSnapshot(
      buildWowSyncExport({
        character: { name: "Retailchar", realm: "Area52", clientVersion: "12.1.0", clientFamily: "Retail", interface: "120100", moneyCopper: 999999 },
      }),
    );

    const versions = store.listVersions();
    const era = versions.find((v) => v.version === "classic-era")!;
    const tbc = versions.find((v) => v.version === "tbc-anniversary")!;
    const retail = versions.find((v) => v.version === "retail")!;

    assert.equal(era.characterCount, 1);
    assert.equal(era.totalMoneyCopper, 10000);
    assert.equal(tbc.characterCount, 1);
    assert.equal(tbc.totalMoneyCopper, 700000);
    assert.equal(retail.characterCount, 1);
    assert.equal(retail.totalMoneyCopper, 999999);
  } finally {
    store.close();
  }
});

test("same character name on different realms are stored as distinct characters", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7" } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Bromrik", realm: "Grobbulus", clientVersion: "1.15.7" } }));
    const chars = store.listCharacters("classic-era");
    assert.equal(chars.length, 2);
    assert.notEqual(chars[0].identityKey, chars[1].identityKey);
  } finally {
    store.close();
  }
});

test("recentChanges surfaces a deterministic level-up across snapshots", () => {
  const store = freshStore();
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 18 } }));
    store.importSnapshot(buildWowSyncExport({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6", level: 19 } }));
    const changes = store.recentChanges("tbc-anniversary");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].characterName, "Voodan");
    assert.equal(changes[0].diff.level.delta, 1);
  } finally {
    store.close();
  }
});
