import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrderReadiness } from "@wowsync-dashboard/core";
import { ErpWorkOrderReadinessLine } from "../src/components/ErpWorkOrderReadinessLine.tsx";
import { ErpWorkOrderProgressLine } from "../src/components/ErpWorkOrderProgressLine.tsx";

test("work-order readiness uses qualified player-facing language and preserves action limits", () => {
  const ready: ErpWorkOrderReadiness = { workOrderId: "transfer", state: "READY_FOR_PLAYER_REVIEW", blockingWorkOrderIds: [], unresolvedNeedIds: [], actionTargetNeedIds: [], changedNeedIds: [], reason: "No incomplete plan dependency or linked resource-evidence blocker is recorded. An observed source location does not establish access or a transfer route." };
  const html = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: ready }));
  assert.match(html, /No recorded plan blockers; review manually/);
  assert.match(html, /does not establish access or a transfer route/);
  assert.doesNotMatch(html, /Transfer approved|Execute now/);
  const unknown = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, {}));
  assert.match(unknown, /Plan readiness is unknown/);
  const changed = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: { ...ready, state: "OBSERVATION_CHANGED_REQUIRES_REVIEW", changedNeedIds: ["gold"], reason: "A comparable observation changed. Cause is unknown." } }));
  assert.match(changed, /Observed change requires review/);
  assert.match(changed, /Cause is unknown/);
  const manualSupply = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: { ...ready, state: "MANUAL_SUPPLY_STEP_RECOMMENDED", actionTargetNeedIds: ["ore"], reason: "A current complete observation is below target. Price and route remain unknown; no action is executed." } }));
  assert.match(manualSupply, /Manual supply step can address an observed gap/);
  assert.match(manualSupply, /Price and route remain unknown/);
  assert.doesNotMatch(manualSupply, /Purchase now|Gather now/);
  const unmetCrafting = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: {
    ...ready,
    state: "OBSERVED_RESOURCE_SHORTFALL",
    reason: "The assigned character does not meet an observed crafting prerequisite.",
    capabilityChecks: [{ needId: "recipe", kind: "RECIPE", assignedIdentityKey: "forever:realm:Crafter", evidenceSourceIdentityKey: "forever:realm:Crafter", state: "REQUIREMENT_NOT_MET", reason: "Recipe knowledge is observed absent.", observedAt: 1_800_000_000, freshness: "recent", sourceSections: [{ section: "character", state: "OBSERVED", completeness: "complete", observedAt: 1_800_000_000 }] }],
  } }));
  assert.match(unmetCrafting, /Assigned character requirement not met/);
  assert.match(unmetCrafting, /Checked on assigned character: forever:realm:Crafter/);
  assert.match(unmetCrafting, /character: OBSERVED · complete/);
  const closedWithHistoricalBlocker = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: {
    ...ready,
    state: "TERMINAL",
    capabilityChecks: [{ needId: "recipe", kind: "RECIPE", state: "REQUIREMENT_NOT_MET", reason: "Historical requirement evidence.", freshness: "recent", sourceSections: [] }],
  } }));
  assert.match(closedWithHistoricalBlocker, /Work order is closed/);
  assert.doesNotMatch(closedWithHistoricalBlocker, /Assigned character requirement not met/);
  const unspecifiedCraft = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: { ...ready, state: "WAITING_FOR_EVIDENCE", reason: "No exact profession or recipe requirement is linked to this crafting step. Material needs alone do not establish that the assigned character can craft the intended result." } }));
  assert.match(unspecifiedCraft, /Waiting for current evidence/);
  assert.match(unspecifiedCraft, /Material needs alone do not establish/);
  const reservationConflict = renderToStaticMarkup(React.createElement(ErpWorkOrderProgressLine, { progress: { workOrderId: "craft", recordedStatus: "IN_PROGRESS", completionRecorded: false, linkedNeedState: "RESOURCE_ALLOCATION_REQUIRES_REVIEW", observationChange: "UNKNOWN", reconciliation: "RESOURCE_ALLOCATION_REQUIRES_REVIEW", coveredNeedIds: [], shortfallNeedIds: [], unresolvedNeedIds: [], allocationConflictNeedIds: ["ore"], changedNeedIds: [], reason: "Current reservations overlap this resource need; intent does not prove locked stock." } }));
  assert.match(reservationConflict, /Resource allocation requires review/);
  assert.match(reservationConflict, /intent does not prove locked stock/);
});
