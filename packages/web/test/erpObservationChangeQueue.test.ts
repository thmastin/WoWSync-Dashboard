import assert from "node:assert/strict";
import { test } from "node:test";
import { erpNeedAnchorId } from "../src/components/erpObservationChangeQueue.ts";

test("observation-review navigation IDs cannot collide when persisted identifiers contain separators", () => {
  assert.equal(erpNeedAnchorId("project / one", "need:ore"), "erp-need-project%20%2F%20one-need%3Aore");
  assert.notEqual(erpNeedAnchorId("a-b", "c"), erpNeedAnchorId("a", "b-c"));
});
