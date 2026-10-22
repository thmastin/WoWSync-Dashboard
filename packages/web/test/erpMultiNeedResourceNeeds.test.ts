import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpProjectView } from "@wowsync-dashboard/core";
import { buildMultiNeedResourceNeeds, type MultiNeedResourceDraft } from "../src/components/erpMultiNeedResourceNeeds.ts";

const project = (overrides: Partial<ErpProjectView> = {}) => ({
  stableId: "project-a", version: "forever", title: "Player plan", status: "ACTIVE", priority: 3, createdAt: 1, updatedAt: 2, revision: 1,
  needs: [], reservations: [], workOrders: [], ...overrides,
}) as unknown as ErpProjectView;
const drafts: MultiNeedResourceDraft[] = [
  { clientKey: "variant", kind: "ITEM_REF", resourceKey: "item:2901:0:0:0:0:0:0:0", label: "Exact Mining Pick variant", requiredQuantity: 1, sourceIdentityKey: "forever::realm::hallo" },
  { clientKey: "gold", kind: "GOLD_COPPER", resourceKey: "ignored", label: "Repair budget", requiredQuantity: 5000, destinationIdentityKey: "forever::realm::hallo" },
];

test("multi-need intake preserves exact keys and player intent in one deterministic batch", () => {
  let id = 0;
  const needs = buildMultiNeedResourceNeeds(project(), drafts, () => `need-${++id}`);
  assert.deepEqual(needs, [
    { stableId: "need-1", kind: "ITEM_REF", resourceKey: "item:2901:0:0:0:0:0:0:0", label: "Exact Mining Pick variant", requiredQuantity: 1, sourceIdentityKey: "forever::realm::hallo" },
    { stableId: "need-2", kind: "GOLD_COPPER", resourceKey: "copper", label: "Repair budget", requiredQuantity: 5000, destinationIdentityKey: "forever::realm::hallo" },
  ]);
});

test("multi-need intake rejects wrong version, malformed identity, invalid quantity, duplicate IDs, and collection overflow", () => {
  const build = (p: ErpProjectView, list = drafts, ids = (() => { let i = 0; return () => `new-${++i}`; })()) => buildMultiNeedResourceNeeds(p, list, ids);
  assert.throws(() => build(project({ status: "PAUSED" })), /active project/);
  assert.throws(() => build(project(), [drafts[0]!]), /between 2 and 4/);
  assert.throws(() => build(project(), [drafts[0]!, { ...drafts[1]!, kind: "ITEM_REF", resourceKey: "item:1:has spaces" }]), /exact itemString/);
  assert.throws(() => build(project(), [drafts[0]!, { ...drafts[1]!, requiredQuantity: 0 }]), /positive whole numbers/);
  assert.throws(() => build(project(), [drafts[0]!, { ...drafts[1]!, sourceIdentityKey: "retail::realm::character" }]), /game version/);
  assert.throws(() => build(project(), drafts, () => "duplicate"), /unique requirement IDs/);
  const full = project({ needs: Array.from({ length: 199 }, (_, index) => ({ stableId: `existing-${index}`, kind: "ITEM_ID", resourceKey: "1", label: `Need ${index}`, requiredQuantity: 1 })) as ErpProjectView["needs"] });
  assert.throws(() => build(full), /room for only 1 more requirement/);
});
