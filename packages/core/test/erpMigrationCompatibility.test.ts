// Synthetic frozen-schema compatibility test. It represents an installation created before the
// durable ERP demand table existed; it does not claim to cover a generalized migration framework.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("[SYNTHETIC LEGACY SCHEMA] creating the ERP demand table preserves existing observations and remains idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "wowsync-erp-legacy-schema-"));
  const file = join(directory, "legacy.sqlite");
  try {
    const original = new SqliteSnapshotStore(file);
    const imported = original.importSnapshot(buildWowSyncExport({
      generatedAt: 1_791_549_000,
      character: { name: "Legacy ERP Fixture", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 80, moneyCopper: 12_345 },
      bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:930201::::::::80", name: "Synthetic Material", qty: 7 }] }] },
    }));
    const snapshotsBefore = original.listSnapshots(imported.character.identityKey);
    const factsBefore = original.buildAccountFacts("retail", 1_791_549_100);
    original.close();

    // Freeze the pre-ERP state by removing only the additive demands table. Product rows are left untouched.
    const legacy = new DatabaseSync(file);
    legacy.exec("DROP TABLE IF EXISTS demands");
    legacy.close();

    for (let open = 0; open < 2; open++) {
      const upgraded = new SqliteSnapshotStore(file);
      try {
        assert.deepEqual(upgraded.listSnapshots(imported.character.identityKey), snapshotsBefore, "legacy snapshot JSON and evidence are unchanged");
        assert.deepEqual(upgraded.buildAccountFacts("retail", 1_791_549_100), factsBefore, "legacy account facts are unchanged");
        assert.deepEqual(upgraded.listDemands("retail"), [], "schema creation does not invent user intent");
        const schema = new DatabaseSync(file, { readOnly: true });
        try {
          const table = schema.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'demands'").get() as { count: number };
          const activeIndex = schema.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_demands_active_key'").get() as { count: number };
          assert.equal(Number(table.count), 1);
          assert.equal(Number(activeIndex.count), 1);
          assert.equal(schema.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        } finally {
          schema.close();
        }
      } finally {
        upgraded.close();
      }
    }

    const reopened = new SqliteSnapshotStore(file);
    try {
      const intent = reopened.createDemand({ baseItemId: 930201, requiredQuantity: 12, purpose: "Synthetic future plan" });
      assert.equal(reopened.listDemands("retail")[0]?.stableId, intent.stableId);
    } finally {
      reopened.close();
    }
    const persisted = new SqliteSnapshotStore(file);
    try {
      assert.equal(persisted.listDemands("retail")[0]?.requiredQuantity, 12, "post-upgrade intent survives a second reopen");
      assert.deepEqual(persisted.listSnapshots(imported.character.identityKey), snapshotsBefore);
    } finally {
      persisted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
