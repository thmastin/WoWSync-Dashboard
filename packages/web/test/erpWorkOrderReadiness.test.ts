import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrderReadiness } from "@wowsync-dashboard/core";
import { ErpWorkOrderReadinessLine } from "../src/components/ErpWorkOrderReadinessLine.tsx";

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
});
