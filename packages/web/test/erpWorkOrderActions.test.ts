import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErpWorkOrder } from "@wowsync-dashboard/core";
import { ErpWorkOrderActions } from "../src/components/ErpWorkOrderActions.tsx";

const order = (status: ErpWorkOrder["status"]): ErpWorkOrder => ({ stableId: "gather", kind: "GATHER", status, title: "Gather supplies", resourceNeedIds: [], dependsOn: [] });
const render = (status: ErpWorkOrder["status"]) => renderToStaticMarkup(React.createElement(ErpWorkOrderActions, { order: order(status), disabled: false, onStatus: () => undefined, onComplete: () => undefined }));

test("manual work-order status actions expose planning transitions without game-operation controls", () => {
  const planned = render("PLANNED");
  assert.match(planned, /Mark in progress/);
  assert.match(planned, /Wait for evidence/);
  assert.match(planned, /Record completion\.\.\./);
  assert.match(planned, /Changes saved plan state only/);
  const running = render("IN_PROGRESS");
  assert.match(running, /Return to planned/);
  const waiting = render("WAITING_FOR_EVIDENCE");
  assert.match(waiting, /Resume manual work/);
  assert.doesNotMatch(planned + running + waiting, /execute transfer|send mail|craft automatically/i);
  assert.equal(render("COMPLETED"), "");
  assert.equal(render("CANCELLED"), "");
});
