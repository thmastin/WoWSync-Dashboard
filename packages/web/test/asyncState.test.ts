// The loading / ready / error state machine behind every API-backed screen.
// The property that matters most: a slow reply to a superseded request can
// never overwrite the state of the current one (e.g. TBC facts appearing
// under the Retail tab because the TBC request finished last).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asyncReducer, initialAsyncState, type AsyncAction, type AsyncState } from "../src/asyncState.ts";

type Facts = { version: string };
const run = (actions: AsyncAction<Facts>[], from: AsyncState<Facts> = initialAsyncState<Facts>()) => actions.reduce(asyncReducer<Facts>, from);

test("starts in 'loading' with no data", () => {
  const s = initialAsyncState<Facts>();
  assert.equal(s.status, "loading");
  assert.equal(s.data, undefined);
});

test("loading -> ready carries the data", () => {
  const s = run([{ type: "start", requestId: 1, keepData: false }, { type: "success", requestId: 1, data: { version: "retail" } }]);
  assert.deepEqual(s, { status: "ready", requestId: 1, data: { version: "retail" } });
});

test("loading -> error keeps the error and (for a first load) has no data to fall back on", () => {
  const err = new Error("down");
  const s = run([{ type: "start", requestId: 1, keepData: false }, { type: "failure", requestId: 1, error: err }]);
  assert.equal(s.status, "error");
  assert.equal((s as { error: unknown }).error, err);
  assert.equal(s.data, undefined);
});

test("retry: error -> loading -> ready", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "failure", requestId: 1, error: new Error("down") },
    { type: "start", requestId: 2, keepData: true },
    { type: "success", requestId: 2, data: { version: "retail" } },
  ]);
  assert.equal(s.status, "ready");
  assert.deepEqual(s.data, { version: "retail" });
});

test("a slow reply to a superseded request is IGNORED (the tab-switch race)", () => {
  // Request 1 (TBC) is still in flight when the user switches to Retail (request 2).
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "start", requestId: 2, keepData: false },
    { type: "success", requestId: 2, data: { version: "retail" } },
    { type: "success", requestId: 1, data: { version: "tbc-anniversary" } }, // arrives late
  ]);
  assert.deepEqual(s.data, { version: "retail" });
  assert.equal(s.requestId, 2);
});

test("a superseded request's FAILURE is ignored too (it must not replace good data with an error)", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "start", requestId: 2, keepData: false },
    { type: "success", requestId: 2, data: { version: "retail" } },
    { type: "failure", requestId: 1, error: new Error("late failure") },
  ]);
  assert.equal(s.status, "ready");
  assert.deepEqual(s.data, { version: "retail" });
});

test("a reply that arrives while a newer request is loading does not end the loading state", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "start", requestId: 2, keepData: false },
    { type: "success", requestId: 1, data: { version: "tbc-anniversary" } },
  ]);
  assert.equal(s.status, "loading");
  assert.equal(s.data, undefined, "the old resource's data is not shown for the new one");
});

test("a refresh of the SAME resource keeps its data visible while reloading (no flash, no lost place)", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "success", requestId: 1, data: { version: "retail" } },
    { type: "start", requestId: 2, keepData: true },
  ]);
  assert.equal(s.status, "loading");
  assert.deepEqual(s.data, { version: "retail" });
});

test("switching to a DIFFERENT resource drops the old data at once", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "success", requestId: 1, data: { version: "retail" } },
    { type: "start", requestId: 2, keepData: false },
  ]);
  assert.equal(s.status, "loading");
  assert.equal(s.data, undefined);
});

test("a failed refresh keeps the last good data alongside the error (the UI decides what to show; nothing is fabricated)", () => {
  const s = run([
    { type: "start", requestId: 1, keepData: false },
    { type: "success", requestId: 1, data: { version: "retail" } },
    { type: "start", requestId: 2, keepData: true },
    { type: "failure", requestId: 2, error: new Error("down") },
  ]);
  assert.equal(s.status, "error");
  assert.deepEqual(s.data, { version: "retail" });
});

test("the reducer is pure: it never mutates the state it is given", () => {
  const before = Object.freeze({ status: "ready", requestId: 1, data: Object.freeze({ version: "retail" }) }) as AsyncState<Facts>;
  const after = asyncReducer(before, { type: "start", requestId: 2, keepData: false });
  assert.equal(before.status, "ready");
  assert.notEqual(after, before);
});
