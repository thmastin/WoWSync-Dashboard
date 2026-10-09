import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrderReadiness } from "@wowsync-dashboard/core";
import { ErpWorkOrderReadinessLine } from "../src/components/ErpWorkOrderReadinessLine.tsx";

test("work-order readiness uses qualified player-facing language and preserves action limits", () => {
  const ready: ErpWorkOrderReadiness = { workOrderId: "transfer", state: "READY_FOR_PLAYER_REVIEW", blockingWorkOrderIds: [], unresolvedNeedIds: [], reason: "No incomplete plan dependency or linked resource-evidence blocker is recorded. An observed source location does not establish access or a transfer route." };
  const html = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, { readiness: ready }));
  assert.match(html, /No recorded plan blockers; review manually/);
  assert.match(html, /does not establish access or a transfer route/);
  assert.doesNotMatch(html, /Transfer approved|Execute now/);
  const unknown = renderToStaticMarkup(React.createElement(ErpWorkOrderReadinessLine, {}));
  assert.match(unknown, /Plan readiness is unknown/);
});
