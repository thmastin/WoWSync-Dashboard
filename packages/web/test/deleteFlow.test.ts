// A failed deletion must never look like a successful one. performDelete is the
// single decision point; the modal only renders its outcome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import { performDelete } from "../src/deleteFlow.ts";

const KEY = "forever::classic beta pvp 2::hallo emberstone";
const ok = async (key: string) => ({ deleted: { identityKey: key, snapshotsDeleted: 2 } });
const failing = (err: unknown) => async () => {
  throw err;
};

test("a reply that names the character is 'deleted'", async () => {
  assert.deepEqual(await performDelete(KEY, ok), { kind: "deleted" });
});

test("a 200 whose body does not confirm THIS character is a failure, not a success", async () => {
  for (const reply of [{}, { deleted: {} }, { deleted: { identityKey: "someone::else::entirely" } }, { deleted: { identityKey: 42 } }, {}] as const) {
    const outcome = await performDelete(KEY, async () => reply as never);
    assert.equal(outcome.kind, "failed", JSON.stringify(reply));
    assert.match((outcome as { message: string }).message, /did not confirm/);
  }
});

test("the server's own CHARACTER_NOT_FOUND 404 is 'already-gone' - the message says nothing was removed by this action", async () => {
  const outcome = await performDelete(KEY, failing(new ApiError("Character not found", "http", 404, "CHARACTER_NOT_FOUND")));
  assert.equal(outcome.kind, "already-gone");
  assert.match((outcome as { message: string }).message, /already gone/);
  assert.match((outcome as { message: string }).message, /removed nothing/);
});

test("any OTHER 404 is a failure: a wrong server / proxy / old build must not be mistaken for 'already deleted'", async () => {
  for (const err of [
    new ApiError("Not found (HTTP 404).", "http", 404), // no code: not the server's own answer
    new ApiError("Not found.", "http", 404, "NOT_FOUND"), // the API's catch-all, e.g. an old build without the DELETE route
    new ApiError("Not found", "http", 404, "SOMETHING_ELSE"),
  ]) {
    assert.equal((await performDelete(KEY, failing(err))).kind, "failed", String(err.code));
  }
});

test("a REFUSAL (an HTTP error) is a failure that says the character was not deleted, with the reason", async () => {
  const cases: [ApiError, RegExp][] = [
    [new ApiError("The server reported an error (HTTP 500).", "http", 500), /HTTP 500/],
    [new ApiError("Confirmation does not match the character being deleted. Nothing was deleted.", "http", 400), /does not match/],
  ];
  for (const [err, message] of cases) {
    const outcome = await performDelete(KEY, failing(err));
    assert.equal(outcome.kind, "failed", err.kind);
    assert.match((outcome as { message: string }).message, message);
    assert.match((outcome as { message: string }).message, /^Not deleted:/);
  }
});

test("when the request or its reply was LOST (network, unparseable, unexpected shape) the outcome is unknown - never 'not deleted'", async () => {
  const cases: [ApiError, RegExp][] = [
    [new ApiError("Can't reach the WoWSync server. Is it running?", "network"), /Can't reach/],
    [new ApiError("The server sent a reply that is not valid JSON.", "parse", 200), /not valid JSON/],
    [new ApiError("The server sent an unexpected reply.", "shape", 200), /unexpected reply/],
  ];
  for (const [err, message] of cases) {
    const outcome = await performDelete(KEY, failing(err));
    assert.equal(outcome.kind, "failed", err.kind);
    const text = (outcome as { message: string }).message;
    assert.match(text, message);
    assert.match(text, /Could not confirm the deletion/);
    assert.match(text, /may or may not have happened/);
    assert.doesNotMatch(text, /^Not deleted/, "the deletion could have committed before the reply was lost");
  }
});

test("a non-ApiError exception (a bug, an abort) is also a failure, never a success", async () => {
  assert.equal((await performDelete(KEY, failing(new Error("kaboom")))).kind, "failed");
  assert.equal((await performDelete(KEY, failing("string thrown"))).kind, "failed");
});

test("the delete function is called exactly once with the exact identity key", async () => {
  const calls: string[] = [];
  await performDelete(KEY, async (key) => {
    calls.push(key);
    return { deleted: { identityKey: key } };
  });
  assert.deepEqual(calls, [KEY]);
});
