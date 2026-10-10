import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrderProgress } from "@wowsync-dashboard/core";
import { ErpWorkOrderProgressLine } from "../src/components/ErpWorkOrderProgressLine.tsx";

const progress: ErpWorkOrderProgress = {
  workOrderId: "mail_item", recordedStatus: "COMPLETED", completionRecorded: true,
  linkedNeedState: "ALL_CURRENTLY_MET", observationChange: "CHANGED", reconciliation: "PLAYER_RECORDED_COMPLETE",
  coveredNeedIds: ["pick"], shortfallNeedIds: [], unresolvedNeedIds: [], allocationConflictNeedIds: [], changedNeedIds: ["pick"],
  reason: "The player marked this work order complete in the saved plan. Linked resource evidence is reported separately and does not verify which action occurred.",
};

test("project progress explains player completion without attributing observed inventory changes", () => {
  const html = renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, { progress }));
  assert.match(html, /Player recorded complete/);
  assert.match(html, /does not verify which action occurred/);
  const changed = renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, { progress: { ...progress, reconciliation: "OBSERVATION_CHANGED_CAUSE_UNKNOWN", completionRecorded: false, recordedStatus: "IN_PROGRESS", reason: "Observed resource changed; cause unknown." } }));
  assert.match(changed, /Observed resource change; cause unknown/);
  assert.doesNotMatch(changed, /Transfer completed|Craft completed/);
  const conflict = renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, { progress: { ...progress, reconciliation: "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL", linkedNeedState: "CURRENT_SHORTFALL", shortfallNeedIds: ["pick"], reason: "Review the conflicting plan and current linked evidence." } }));
  assert.match(conflict, /Completion note conflicts with a linked shortfall/);
  assert.match(renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, {})), /Progress reconciliation is unknown/);
});

test("manual sale presentation separates item and gold observations and keeps sale causality unknown", () => {
  const html = renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, { progress: { ...progress, sellObservationReviews: [{ sellerIdentityKey: "classic-era::realm a::crafter", needId: "sale_item", resourceKey: "item:159:variant", state: "GOLD_INCREASED", itemState: "ITEM_CHANGED", freshness: "recent", previousFreshness: "recent", goldComparison: { section: "character gold", previousQuantity: 500, currentQuantity: 700, delta: 200, previousObservedAt: 100, currentObservedAt: 200 }, itemComparisons: [{ section: "bags", previousQuantity: 4, currentQuantity: 2, delta: -2, previousObservedAt: 100, currentObservedAt: 200 }], interpretation: "CAUSE_UNKNOWN", reason: "Item and gold changed independently; no sale is established." }] } }));
  assert.match(html, /Manual sale observations \(cause unknown\)/);
  assert.match(html, /item:159:variant/);
  assert.match(html, /GOLD INCREASED/);
  assert.match(html, /500 → 700 copper/);
  assert.match(html, /bags: 4 → 2/);
  assert.match(html, /Neither change proves a sale/);
});
