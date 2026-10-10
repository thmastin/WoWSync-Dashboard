import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpProjectView } from "@wowsync-dashboard/core";
import { buildMultiNeedWorkOrders, workOrderInstructions } from "../src/components/erpMultiNeedWorkOrders.ts";

const project = (overrides: Partial<ErpProjectView> = {}) => ({
  stableId: "project-a", version: "forever", title: "Supply two needs", status: "ACTIVE", priority: 3, createdAt: 1, updatedAt: 2, revision: 1,
  needs: [
    { stableId: "ore", kind: "ITEM_REF", resourceKey: "item:2770:0:0:0:0:0:0:0", label: "Copper Ore", requiredQuantity: 8, sourceIdentityKey: "forever::realm::miner" },
    { stableId: "recipe", kind: "RECIPE", resourceKey: "1234", label: "Unknown recipe", requiredQuantity: 1 },
  ], reservations: [],
  workOrders: [{ stableId: "prior", kind: "INVESTIGATE", status: "IN_PROGRESS", title: "Check current evidence", resourceNeedIds: [], dependsOn: [] }],
  ...overrides,
}) as unknown as ErpProjectView;

function draft(needId: string, clientKey: string, extra: Partial<Parameters<typeof buildMultiNeedWorkOrders>[1][number]> = {}) {
  return { needId, clientKey, kind: "INVESTIGATE" as const, title: `Review ${needId}`, instructions: `Player plan for ${needId}.`, ...extra };
}

test("multi-need composer builds heterogeneous single-need orders atomically with explicit backward dependencies", () => {
  let next = 0;
  const orders = buildMultiNeedWorkOrders(project(), [
    draft("ore", "ore-task", { kind: "GATHER", assignedIdentityKey: "forever::realm::miner", dependsOn: ["prior"] }),
    draft("recipe", "recipe-task", { kind: "CRAFT", assignedIdentityKey: "forever::realm::miner", dependsOn: ["draft:ore-task"] }),
  ], () => `new-${++next}`);
  assert.deepEqual(orders.map((order) => [order.stableId, order.kind, order.status, order.resourceNeedIds, order.dependsOn]), [
    ["new-1", "GATHER", "PLANNED", ["ore"], ["prior"]],
    ["new-2", "CRAFT", "PLANNED", ["recipe"], ["new-1"]],
  ]);
  assert.equal(orders[0]?.assignedIdentityKey, "forever::realm::miner");
  assert.equal(orders[0]?.sourceIdentityKey, undefined, "character assignment is not treated as resource source");
  assert.match(orders[0]?.instructions ?? "", /SYSTEM EVIDENCE BOUNDARY:.*did not execute or verify any game action/);
});

test("composer rejects stale/open/duplicate needs, wrong version identities, and malformed plans", () => {
  const make = (p = project(), drafts = [draft("ore", "a"), draft("recipe", "b")]) => buildMultiNeedWorkOrders(p, drafts, (() => { let n = 0; return () => `new-${++n}`; })());
  assert.throws(() => make(project({ status: "PAUSED" })), /active project/);
  assert.throws(() => make(project(), [draft("ore", "a")]), /between 2 and 4/);
  assert.throws(() => make(project(), [draft("ore", "a"), draft("missing", "b")]), /must exist/);
  assert.throws(() => make(project(), [draft("ore", "a"), draft("ore", "b")]), /only once/);
  assert.throws(() => make(project({ workOrders: [{ stableId: "open", kind: "OTHER", status: "PLANNED", title: "Open", resourceNeedIds: ["ore"], dependsOn: [] }] }), [draft("ore", "a"), draft("recipe", "b")]), /already has an open work order/);
  assert.throws(() => make(project(), [draft("ore", "a", { assignedIdentityKey: "retail::realm::miner" }), draft("recipe", "b")]), /game version/);
  assert.throws(() => make(project(), [draft("ore", "a", { title: " " }), draft("recipe", "b")]), /title/);
  assert.throws(() => make(project(), [draft("ore", "a", { instructions: "x".repeat(4001) }), draft("recipe", "b")]), /instructions/);
  assert.throws(() => make(project(), [draft("ore", "a", { instructions: "x".repeat(3850) }), draft("recipe", "b")]), /required evidence boundary/);
  assert.throws(() => make(project(), [draft("ore", "a", { dependsOn: ["draft:b"] }), draft("recipe", "b")]), /earlier task/);
  assert.throws(() => make(project(), [draft("ore", "a", { dependsOn: ["missing"] }), draft("recipe", "b")]), /no longer open/);
  assert.throws(() => buildMultiNeedWorkOrders(project(), [draft("ore", "a"), draft("recipe", "b")], () => "duplicate"), /unique stable work-order IDs/);
  const full = project({ workOrders: Array.from({ length: 199 }, (_, index) => ({ stableId: `existing-${index}`, kind: "OTHER", status: "CANCELLED", title: `Old ${index}`, resourceNeedIds: [], dependsOn: [] })) as ErpProjectView["workOrders"] });
  assert.throws(() => make(full), /room for only 1 more work order/);
});

test("work-type guidance preserves the evidence boundary", () => {
  assert.match(workOrderInstructions("PURCHASE", "Copper Ore"), /planning intent only/);
  assert.match(workOrderInstructions("CRAFT", "Unknown recipe"), /no item movement, purchase, craft, equip/);
  assert.match(workOrderInstructions("PROVISION", "Item"), /no item movement/);
});
