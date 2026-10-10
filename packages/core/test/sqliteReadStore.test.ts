import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotReadStore, SqliteSnapshotStore, SnapshotReadStoreOpenError } from "../src/sqliteStore.ts";
import type { SnapshotReadStore } from "../src/store.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

function withTemporaryDirectory(fn: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "wowsync-read-store-"));
  try { fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function digest(pathname: string): string | undefined {
  return existsSync(pathname) ? createHash("sha256").update(readFileSync(pathname)).digest("hex") : undefined;
}

function journalMode(pathname: string): string {
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    return (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  } finally { db.close(); }
}

function createValidDatabase(pathname: string): void {
  const writable = new SqliteSnapshotStore(pathname);
  try {
    writable.importSnapshot(buildWowSyncExport({ generatedAt: 1_800_000_001, character: { name: "Reader", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper: 0 } }));
  } finally { writable.close(); }
}

function acceptsReadStore(_store: SnapshotReadStore): void {}

test("[STRUCTURAL] DashboardReadModel's store dependency can be satisfied without mutation methods", () => {
  withTemporaryDirectory((directory) => {
    const pathname = path.join(directory, "valid.sqlite");
    createValidDatabase(pathname);
    const writable = new SqliteSnapshotStore(pathname);
    const readOnly = new SqliteSnapshotReadStore(pathname);
    try {
      acceptsReadStore(writable);
      acceptsReadStore(readOnly);
      assert.equal("importSnapshot" in readOnly, false);
      assert.equal("deleteCharacter" in readOnly, false);
      assert.equal(readOnly.listCharacters("retail").length, 1);
      assert.equal(readOnly.loadSharedJournal().entries.size, 0, "read-only consumers can inspect an immutable empty shared journal without acquiring mutation methods");
      const model = new DashboardReadModel(readOnly, () => 1_800_000_010);
      assert.equal(model.getCharacterSummary({ version: "retail", name: "Reader", realm: "Cairne" }).status, "FOUND");
    } finally {
      readOnly.close();
      writable.close();
    }
  });
});

test("[REAL] read-only store reads an existing database without schema or journal-mode changes", () => {
  withTemporaryDirectory((directory) => {
    const pathname = path.join(directory, "valid.sqlite");
    createValidDatabase(pathname);
    const before = digest(pathname);
    const modeBefore = journalMode(pathname);
    const readOnly = new SqliteSnapshotReadStore(pathname);
    try {
      assert.equal(readOnly.listCharacters("retail")[0]?.name, "Reader");
    } finally { readOnly.close(); }
    assert.equal(journalMode(pathname), modeBefore);
    assert.equal(digest(pathname), before, "read-only initialization must not alter the database file");
  });
});

test("[REAL] read-only connection rejects a mutation even when bypassing the narrow wrapper type", () => {
  withTemporaryDirectory((directory) => {
    const pathname = path.join(directory, "valid.sqlite");
    createValidDatabase(pathname);
    const before = digest(pathname);
    const readOnly = new SqliteSnapshotReadStore(pathname);
    try {
      const hidden = readOnly as unknown as { store: SqliteSnapshotStore };
      assert.throws(
        () => hidden.store.importSnapshot(buildWowSyncExport({ generatedAt: 1_800_000_002, character: { name: "Writer", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } })),
        /readonly|read-only/i,
      );
    } finally { readOnly.close(); }
    assert.equal(digest(pathname), before);
  });
});

test("[REAL] missing, blank, and incompatible databases fail explicitly without being initialized", () => {
  withTemporaryDirectory((directory) => {
    const missing = path.join(directory, "missing.sqlite");
    assert.throws(() => new SqliteSnapshotReadStore(missing), SnapshotReadStoreOpenError);
    assert.equal(existsSync(missing), false);

    for (const [name, make] of [
      ["blank.sqlite", () => writeFileSync(path.join(directory, "blank.sqlite"), "not sqlite")],
      ["incompatible.sqlite", () => { const db = new DatabaseSync(path.join(directory, "incompatible.sqlite")); try { db.exec("CREATE TABLE unrelated (id INTEGER)"); } finally { db.close(); } }],
    ] as const) {
      const pathname = path.join(directory, name);
      make();
      const before = digest(pathname);
      assert.throws(() => new SqliteSnapshotReadStore(pathname), SnapshotReadStoreOpenError);
      assert.equal(digest(pathname), before, `${name} must not be repaired or initialized`);
    }
  });
});

type SnapshotReadStoreHasImport = SnapshotReadStore extends { importSnapshot: unknown } ? true : false;
const snapshotReadStoreHasNoImport: SnapshotReadStoreHasImport = false;
assert.equal(snapshotReadStoreHasNoImport, false);
