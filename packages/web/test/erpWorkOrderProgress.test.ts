import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrderProgress } from "@wowsync-dashboard/core";
import { ErpWorkOrderProgressLine } from "../src/components/ErpWorkOrderProgressLine.tsx";

const progress: ErpWorkOrderProgress = {
  workOrderId: "mail_item", recordedStatus: "COMPLETED", completionRecorded: true,
  linkedNeedState: "ALL_CURRENTLY_MET", observationChange: "CHANGED", reconciliation: "PLAYER_RECORDED_COMPLETE",
  coveredNeedIds: ["pick"], shortfallNeedIds: [], unresolvedNeedIds: [], changedNeedIds: ["pick"],
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
