// Explicit Demand persistence: creation, the DB-level active-uniqueness invariant, update, deactivation
// (not a delete), version scoping, and that a read-only store never exposes any write method at the type
// level (enforced by SqliteSnapshotReadStore implementing SnapshotReadStore, which has no createDemand).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DemandConflictError, DemandValidationError } from "../src/demand.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

function freshStore(): SqliteSnapshotStore {
  return new SqliteSnapshotStore(":memory:");
}

test("createDemand persists an ACTIVE STOCK_TARGET demand with a stable id and timestamps", () => {
  const store = freshStore();
  try {
    const demand = store.createDemand({ baseItemId: 1001, requiredQuantity: 40, purpose: "Enchanting mats" });
    assert.equal(demand.demandType, "STOCK_TARGET");
    assert.equal(demand.gameVersion, "retail");
    assert.equal(demand.commodity.baseItemId, 1001);
    assert.equal(demand.requiredQuantity, 40);
    assert.equal(demand.purpose, "Enchanting mats");
    assert.equal(demand.status, "ACTIVE");
    assert.ok(demand.stableId.length > 0);
    assert.equal(demand.createdAt, demand.updatedAt);
  } finally {
    store.close();
  }
});

test("a second ACTIVE demand for the same (version, type, item) key is rejected with DemandConflictError, not a silently chosen winner", () => {
  const store = freshStore();
  try {
    const first = store.createDemand({ baseItemId: 1001, requiredQuantity: 40 });
    assert.throws(
      () => store.createDemand({ baseItemId: 1001, requiredQuantity: 999 }),
      (err: unknown) => err instanceof DemandConflictError && err.existingStableId === first.stableId,
    );
    // The DB-level partial unique index backs this, not just the application check:
    assert.equal(store.listDemands("retail").filter((d) => d.status === "ACTIVE" && d.commodity.baseItemId === 1001).length, 1);
  } finally {
    store.close();
  }
});

test("a different base item id does not conflict, and deactivating the first demand frees its key for a new active one", () => {
  const store = freshStore();
  try {
    store.createDemand({ baseItemId: 1001, requiredQuantity: 40 });
    assert.doesNotThrow(() => store.createDemand({ baseItemId: 1002, requiredQuantity: 10 }));
    const first = store.getActiveDemand("retail", "STOCK_TARGET", 1001)!;
    const deactivated = store.deactivateDemand(first.stableId)!;
    assert.equal(deactivated.status, "INACTIVE");
    assert.equal(store.getActiveDemand("retail", "STOCK_TARGET", 1001), undefined);
    // The row is not deleted: it is still visible in the version's full demand list.
    assert.ok(store.listDemands("retail").some((d) => d.stableId === first.stableId && d.status === "INACTIVE"));
    assert.doesNotThrow(() => store.createDemand({ baseItemId: 1001, requiredQuantity: 50 }));
  } finally {
    store.close();
  }
});

test("updateDemand changes requiredQuantity/purpose in place and bumps updatedAt without changing stableId or createdAt", () => {
  const store = freshStore();
  try {
    const original = store.createDemand({ baseItemId: 2001, requiredQuantity: 5, purpose: "initial" });
    const updated = store.updateDemand(original.stableId, { requiredQuantity: 15, purpose: "revised" })!;
    assert.equal(updated.stableId, original.stableId);
    assert.equal(updated.createdAt, original.createdAt);
    assert.equal(updated.requiredQuantity, 15);
    assert.equal(updated.purpose, "revised");
    assert.ok(updated.updatedAt >= original.updatedAt);
    // A partial update leaves the other field untouched.
    const partial = store.updateDemand(original.stableId, { requiredQuantity: 20 })!;
    assert.equal(partial.purpose, "revised");
    assert.equal(partial.requiredQuantity, 20);
  } finally {
    store.close();
  }
});

test("updateDemand and deactivateDemand on an unknown stableId return undefined rather than throwing", () => {
  const store = freshStore();
  try {
    assert.equal(store.updateDemand("demand_nonexistent", { requiredQuantity: 1 }), undefined);
    assert.equal(store.deactivateDemand("demand_nonexistent"), undefined);
  } finally {
    store.close();
  }
});

test("createDemand rejects invalid input with DemandValidationError before touching the database", () => {
  const store = freshStore();
  try {
    assert.throws(() => store.createDemand({ baseItemId: -1, requiredQuantity: 5 }), (err: unknown) => err instanceof DemandValidationError);
    assert.equal(store.listDemands("retail").length, 0, "the invalid attempt wrote nothing");
  } finally {
    store.close();
  }
});

test("listDemands and getActiveDemand are version-scoped: demand is Retail-only in Slice 1 and other versions see nothing", () => {
  const store = freshStore();
  try {
    store.createDemand({ baseItemId: 3001, requiredQuantity: 5 });
    assert.equal(store.listDemands("classic-era").length, 0);
    assert.equal(store.listDemands("tbc-anniversary").length, 0);
    assert.equal(store.getActiveDemand("classic-era", "STOCK_TARGET", 3001), undefined);
    assert.equal(store.listDemands("retail").length, 1);
  } finally {
    store.close();
  }
});

test("demands persist across a reopen of the same database file", () => {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-demand-"));
  const path = join(folder, "demand.sqlite");
  try {
    const first = new SqliteSnapshotStore(path);
    const created = first.createDemand({ baseItemId: 4001, requiredQuantity: 7, purpose: "persisted" });
    first.close();
    const second = new SqliteSnapshotStore(path);
    try {
      const reloaded = second.getActiveDemand("retail", "STOCK_TARGET", 4001);
      assert.deepEqual(reloaded, created);
    } finally {
      second.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
