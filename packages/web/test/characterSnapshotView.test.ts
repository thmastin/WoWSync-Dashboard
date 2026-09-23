import assert from "node:assert/strict";
import { test } from "node:test";
import {
  characterHeaderView,
  isViewingHistoricalSnapshot,
  latestSnapshotId,
  snapshotObservationAt,
} from "../src/characterSnapshotView.ts";
import type { ParsedSnapshot, StoredCharacterSummary, StoredSnapshot } from "../src/types.ts";

function emptyParsed(over: Partial<ParsedSnapshot["character"]>): ParsedSnapshot {
  return {
    character: {
      name: "Virek",
      realm: "Cairne",
      class: "Hunter",
      faction: "Horde",
      level: 90,
      ...over,
    },
    location: { status: { state: "OBSERVED" }, zone: "Silvermoon" },
    equipment: { status: { state: "UNKNOWN" }, slots: [] },
    bags: { status: { state: "UNKNOWN" }, items: [] },
    bank: { status: { state: "UNKNOWN" }, items: [] },
    professions: { status: { state: "UNKNOWN" }, entries: [] },
    spells: { status: { state: "UNKNOWN" }, entries: [] },
    trainer: { status: { state: "UNKNOWN" }, categories: [] },
  } as ParsedSnapshot;
}

function snap(over: Partial<StoredSnapshot> & Pick<StoredSnapshot, "id" | "parsed">): StoredSnapshot {
  return {
    characterId: 1,
    importedAt: 1_700_000_100,
    ...over,
  };
}

const character: StoredCharacterSummary = {
  identityKey: "retail::cairne::virek",
  version: "retail",
  name: "Virek",
  realm: "Cairne",
  class: "Hunter",
  faction: "Horde",
  latestLevel: 90,
  latestGeneratedAt: 1_700_000_200,
  latestImportedAt: 1_700_000_210,
  snapshotCount: 2,
};

test("latest snapshot is list[0]; historical means any other id", () => {
  const list = [
    snap({ id: 20, generatedAt: 200, parsed: emptyParsed({ level: 90 }) }),
    snap({ id: 10, generatedAt: 100, parsed: emptyParsed({ level: 85 }) }),
  ];
  assert.equal(latestSnapshotId(list), 20);
  assert.equal(isViewingHistoricalSnapshot(20, list), false);
  assert.equal(isViewingHistoricalSnapshot(10, list), true);
  assert.equal(isViewingHistoricalSnapshot(null, list), false);
  assert.equal(isViewingHistoricalSnapshot(10, []), false);
});

test("observation time prefers Generated, else importedAt", () => {
  assert.equal(snapshotObservationAt({ generatedAt: 50, importedAt: 99 }), 50);
  assert.equal(snapshotObservationAt({ importedAt: 99 }), 99);
});

test("header follows the selected snapshot, not the character latest", () => {
  const latest = snap({ id: 20, generatedAt: 200, parsed: emptyParsed({ level: 90 }) });
  const older = snap({ id: 10, generatedAt: 100, parsed: emptyParsed({ level: 85 }) });
  const list = [latest, older];

  const onLatest = characterHeaderView(character, latest, list);
  assert.equal(onLatest.viewingHistorical, false);
  assert.equal(onLatest.level, 90);
  assert.equal(onLatest.syncedAt, 200);

  const onOlder = characterHeaderView(character, older, list);
  assert.equal(onOlder.viewingHistorical, true);
  assert.equal(onOlder.level, 85);
  assert.equal(onOlder.syncedAt, 100);
  assert.notEqual(onOlder.level, character.latestLevel);
});

test("without a snapshot, header falls back to the character summary", () => {
  const view = characterHeaderView(character, undefined, []);
  assert.equal(view.viewingHistorical, false);
  assert.equal(view.level, 90);
  assert.equal(view.syncedAt, 1_700_000_200);
});
