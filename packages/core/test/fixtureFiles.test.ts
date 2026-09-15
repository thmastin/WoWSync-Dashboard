// End-to-end sanity check against the saved fixture files (not the in-memory
// builder) — this is closer to what actually happens when a user pastes a
// .txt export into the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

test("Torahn's two snapshots import cleanly and produce the expected TBC diff", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const first = store.importSnapshot(read("tbc-anniversary/torahn-01-level20.txt"));
    assert.equal(first.character.version, "tbc-anniversary");
    assert.equal(first.isFirstSnapshot, true);

    const second = store.importSnapshot(read("tbc-anniversary/torahn-02-level22.txt"));
    assert.equal(second.isFirstSnapshot, false);
    assert.equal(second.diff?.level.delta, 2);
    assert.equal(second.diff?.moneyCopper.delta, 45_000);
    assert.equal(second.diff?.professions.find((p) => p.name === "Mining")?.skill.delta, 14);

    const chars = store.listCharacters("tbc-anniversary");
    assert.equal(chars.length, 1);
    assert.equal(chars[0].snapshotCount, 2);
  } finally {
    store.close();
  }
});

test("Bromrik (Classic Era) and Torahn (TBC) land in isolated version spaces", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(read("classic-era/bromrik-01.txt"));
    store.importSnapshot(read("tbc-anniversary/torahn-01-level20.txt"));
    store.importSnapshot(read("tbc-anniversary/voodan-01.txt"));
    store.importSnapshot(read("tbc-anniversary/tenivard-01.txt"));

    const era = store.listCharacters("classic-era");
    const tbc = store.listCharacters("tbc-anniversary");
    assert.equal(era.length, 1);
    assert.equal(era[0].name, "Bromrik");
    assert.equal(tbc.length, 3);
    assert.ok(tbc.some((c) => c.name === "Torahn"));
    assert.ok(tbc.some((c) => c.name === "Voodan"));
    assert.ok(tbc.some((c) => c.name === "Tenivard"));
  } finally {
    store.close();
  }
});

test("the Retail sample routes to the retail version space via ClientFamily", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const result = store.importSnapshot(read("retail/sample-retail-01.txt"));
    assert.equal(result.character.version, "retail");
  } finally {
    store.close();
  }
});
