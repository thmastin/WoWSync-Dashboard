import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { ErpProjectConflictError } from "../src/erpProjects.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";

test("reservation replan reduces and releases existing commitments across projects atomically", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000);
  try {
    const observed = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Planner", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 10 }] }] }, bank: { containers: [] } }));
    const makeProject = (title: string, needId: string, reservationId: string) => store.createErpProject({ version: "classic-era", title, needs: [{ stableId: needId, kind: "ITEM_REF", resourceKey: "item:159:0:0", label: title, requiredQuantity: 6, sourceIdentityKey: observed.character.identityKey }], reservations: [{ stableId: reservationId, needId, sourceIdentityKey: observed.character.identityKey, quantity: 4, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    const first = makeProject("First plan", "first-need", "first-hold");
    const second = makeProject("Second plan", "second-need", "second-hold");
    const request = [
      { projectId: first.stableId, expectedRevision: first.revision, reservations: first.reservations.map((entry) => ({ ...entry, quantity: 2 })) },
      { projectId: second.stableId, expectedRevision: second.revision, reservations: second.reservations.map((entry) => ({ ...entry, status: "RELEASED" as const })) },
    ];
    const saved = store.replanErpReservationsAtomically("classic-era", request);
    assert.deepEqual(saved?.map((project) => [project.revision, project.reservations[0]?.quantity, project.reservations[0]?.status]), [[2, 2, "ACTIVE"], [2, 4, "RELEASED"]]);
    assert.ok(store.listErpProjectHistory(first.stableId).some((event) => event.kind === "UPDATED" && event.changedFields.includes("reservations")));
    assert.ok(store.listErpProjectHistory(second.stableId).some((event) => event.kind === "UPDATED" && event.changedFields.includes("reservations")));

    const afterFirst = store.getErpProject(first.stableId)!;
    const afterSecond = store.getErpProject(second.stableId)!;
    const staleRequest = [
      { projectId: afterFirst.stableId, expectedRevision: afterFirst.revision, reservations: afterFirst.reservations.map((entry) => ({ ...entry, quantity: 1 })) },
      { projectId: afterSecond.stableId, expectedRevision: 1, reservations: afterSecond.reservations },
    ];
    assert.throws(() => store.replanErpReservationsAtomically("classic-era", staleRequest), ErpProjectConflictError);
    assert.equal(store.getErpProject(afterFirst.stableId)?.reservations[0]?.quantity, 2, "a stale project rejects the entire cross-project replan");

    const increase = [{ projectId: afterFirst.stableId, expectedRevision: afterFirst.revision, reservations: afterFirst.reservations.map((entry) => ({ ...entry, quantity: 3 })) }];
    assert.throws(() => store.replanErpReservationsAtomically("classic-era", increase), (error: unknown) => error instanceof ErpProjectConflictError && error.code === "RESERVATION_INCREASE_BLOCKED");
    assert.equal(store.getErpProject(afterFirst.stableId)?.revision, afterFirst.revision, "an attempted increase writes nothing");

    const reactivation = [{ projectId: afterSecond.stableId, expectedRevision: afterSecond.revision, reservations: afterSecond.reservations.map((entry) => ({ ...entry, status: "ACTIVE" as const })) }];
    assert.throws(() => store.replanErpReservationsAtomically("classic-era", reactivation), (error: unknown) => error instanceof ErpProjectConflictError && error.code === "RESERVATION_REACTIVATION_BLOCKED");
    assert.equal(store.getErpProject(afterSecond.stableId)?.reservations[0]?.status, "RELEASED", "released history cannot be reactivated");

    assert.throws(() => store.replanErpReservationsAtomically("forever", [request[0]!]), TypeError, "cross-version replan is rejected");
    assert.equal(store.getErpProject(afterFirst.stableId)?.revision, afterFirst.revision, "wrong-version rejection leaves project unchanged");
  } finally { store.close(); }
});

test("a completed project's retained reservation can be explicitly released without reopening the project", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000);
  try {
    const observed = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Planner", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 10 }] }] }, bank: { containers: [] } }));
    const created = store.createErpProject({ version: "classic-era", title: "Completed plan", needs: [{ stableId: "completed-need", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Completed plan", requiredQuantity: 6, sourceIdentityKey: observed.character.identityKey }], reservations: [{ stableId: "completed-hold", needId: "completed-need", sourceIdentityKey: observed.character.identityKey, quantity: 4, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    assert.ok(created);
    const completed = store.updateErpProject({ ...created, status: "COMPLETED", completionNote: "Player recorded the project outcome." }, created.revision);
    assert.ok(completed);
    const result = store.replanErpReservationsAtomically("classic-era", [{ projectId: completed.stableId, expectedRevision: completed.revision, reservations: completed.reservations.map((entry) => ({ ...entry, status: "RELEASED" as const })) }]);
    assert.equal(result?.[0]?.status, "COMPLETED", "reservation cleanup does not reopen completed work");
    assert.equal(result?.[0]?.reservations[0]?.status, "RELEASED");
    assert.equal(result?.[0]?.reservations[0]?.quantity, 4, "released history preserves its original quantity");
  } finally { store.close(); }
});
