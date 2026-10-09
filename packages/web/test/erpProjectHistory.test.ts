import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpProjectEvent } from "@wowsync-dashboard/core";
import { ErpProjectHistory } from "../src/components/ErpProjectHistory.tsx";

test("project history renders saved intent chronology and never assigns causes to observed changes", () => {
  const events: ErpProjectEvent[] = [
    { eventId: "e3", projectId: "p", version: "retail", revision: 3, occurredAt: 1_700_000_200, kind: "STATUS_CHANGED", changedFields: ["status", "completionNote"], fromStatus: "ACTIVE", toStatus: "COMPLETED" },
    { eventId: "e2", projectId: "p", version: "retail", revision: 2, occurredAt: 1_700_000_100, kind: "STATUS_CHANGED", changedFields: ["status"], fromStatus: "ACTIVE", toStatus: "PAUSED" },
    { eventId: "e1", projectId: "p", version: "retail", revision: 1, occurredAt: 1_700_000_000, kind: "CREATED", changedFields: ["project"], toStatus: "ACTIVE" },
  ];
  const html = renderToStaticMarkup(createElement(ErpProjectHistory, { events, totalCount: 3, truncated: false }));
  assert.match(html, /Project history \(3 recorded changes\)/);
  assert.ok(html.indexOf("Project created") < html.indexOf("Status: ACTIVE to PAUSED"), "newest-first storage is presented oldest-first");
  assert.match(html, /Status: ACTIVE to COMPLETED/, "a status change with additional fields still shows the status transition");
  assert.match(html, /initial project plan/);
  assert.match(html, /status, completion note/);
  assert.match(html, /do not explain their cause or prove a game action/);
  const truncated = renderToStaticMarkup(createElement(ErpProjectHistory, { events, totalCount: 80, truncated: true }));
  assert.match(truncated, /Showing the latest 3 changes/);
  assert.match(truncated, /Project history \(80 recorded changes\)/);
});
