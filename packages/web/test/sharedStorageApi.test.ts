// The web client seam for shared storage (checkpoint C4): request paths, the guild id sent verbatim, the
// confirmation body, reply validation, and the classified failures (including the shared-storage
// integrity failure's details). No component exists yet (C5); fetch is stubbed, nothing touches a network.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { ApiError, deleteSharedStorageOwner, fetchSharedStorage, isSharedStorageResponse, sharedStorageIntegrityDetails } from "../src/api.ts";
import type { SharedOwnerIdentity } from "../src/types.ts";

interface Call {
  url: string;
  init?: RequestInit;
}
function stubFetch(impl: (call: Call) => Response) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return impl(call);
  });
  return calls;
}
afterEach(() => mock.restoreAll());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const EMPTY = { schema: "shared-storage-1", asOf: 1, warband: null, guilds: [] };
const WARBAND: SharedOwnerIdentity = { kind: "warband", ownerKey: "retail::warband::local", accountScope: "installation-local" };
const guildIdentity = (id: string): SharedOwnerIdentity => ({ kind: "guild", ownerKey: `retail::guild::${id}`, guildClubId: id, guildName: "Some Guild" });

async function failure(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err));
    return err;
  }
  assert.fail("expected a failure");
}

test("fetchSharedStorage reads GET /api/shared-storage and accepts the stable empty document", async () => {
  const calls = stubFetch(() => json(EMPTY));
  const result = await fetchSharedStorage();
  assert.equal(calls[0].url, "/api/shared-storage");
  assert.deepEqual(result, EMPTY);
});

test("the shape check: anything that is not a shared-storage document is a 'shape' error, never a later undefined crash", async () => {
  for (const bad of [{}, { schema: "other", asOf: 1, warband: null, guilds: [] }, { schema: "shared-storage-1", asOf: "x", warband: null, guilds: [] }, { schema: "shared-storage-1", asOf: 1, warband: 5, guilds: [] }, { schema: "shared-storage-1", asOf: 1, warband: null, guilds: {} }, [], null]) {
    assert.equal(isSharedStorageResponse(bad), false, JSON.stringify(bad));
  }
  stubFetch(() => json({ versions: [] }));
  const err = await failure(() => fetchSharedStorage());
  assert.equal(err.kind, "shape");
});

test("deleting the Warband: DELETE /api/shared-storage/warband with its key as the CONFIRMATION only", async () => {
  const calls = stubFetch(() => json({ deleted: { owner: WARBAND, existed: true, observationsDeleted: 1, sourcesDeleted: 2 } }));
  const result = await deleteSharedStorageOwner(WARBAND);
  assert.equal(calls[0].url, "/api/shared-storage/warband");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { confirmOwnerKey: "retail::warband::local" });
  assert.equal(result.deleted.observationsDeleted, 1);
});

test("deleting a guild: the club id is sent verbatim in the path (percent-encoded, never a number) and the body confirms the same owner", async () => {
  const ids = ["18014398509481985", "18014398509481984", "1.8014398509482e+16", "a/b c"];
  for (const id of ids) {
    const calls = stubFetch(() => json({ deleted: { owner: guildIdentity(id), existed: true, observationsDeleted: 1, sourcesDeleted: 1 } }));
    await deleteSharedStorageOwner(guildIdentity(id));
    assert.equal(calls[0].url, `/api/shared-storage/guilds/${encodeURIComponent(id)}`, id);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { confirmOwnerKey: `retail::guild::${id}` }, "the display guild name is not sent as identity");
    mock.restoreAll();
  }
  assert.notEqual(encodeURIComponent("18014398509481985"), encodeURIComponent(String(Number("18014398509481985"))), "sanity: a numeric round trip WOULD change this id");
});

test("a delete reply that does not name an owner is not success", async () => {
  stubFetch(() => json({ ok: true }));
  assert.equal((await failure(() => deleteSharedStorageOwner(WARBAND))).kind, "shape");
});

test("'already gone' is the server's own 404 with code SHARED_OWNER_NOT_FOUND, kept distinct from any other 404", async () => {
  stubFetch(() => json({ error: "No stored shared-storage history for this owner.", code: "SHARED_OWNER_NOT_FOUND" }, 404));
  const err = await failure(() => deleteSharedStorageOwner(WARBAND));
  assert.deepEqual([err.kind, err.status, err.code], ["http", 404, "SHARED_OWNER_NOT_FOUND"]);
});

test("the shared-storage integrity failure keeps its details, so a page can name the damaged owners", async () => {
  const body = {
    error: "The shared-storage state cannot be shown. The stored shared-storage journal failed its integrity check, so nothing was skipped or guessed.",
    code: "SHARED_STORAGE_INTEGRITY",
    damagedOwners: [{ ownerKey: "retail::warband::local", kind: "warband" }, { ownerKey: "retail::guild::111", kind: "guild", guildClubId: "111" }],
  };
  stubFetch(() => json(body, 500));
  const err = await failure(() => fetchSharedStorage());
  assert.deepEqual([err.kind, err.status, err.code], ["http", 500, "SHARED_STORAGE_INTEGRITY"]);
  assert.match(err.message, /integrity check/);
  assert.deepEqual(sharedStorageIntegrityDetails(err)?.damagedOwners, body.damagedOwners);
});

test("sharedStorageIntegrityDetails is undefined for every other failure", async () => {
  stubFetch(() => json({ error: "boom" }, 500));
  assert.equal(sharedStorageIntegrityDetails(await failure(() => fetchSharedStorage())), undefined);
  assert.equal(sharedStorageIntegrityDetails(new Error("x")), undefined);
  assert.equal(sharedStorageIntegrityDetails(new ApiError("x", "http", 500, "SHARED_STORAGE_INTEGRITY")), undefined, "a matching code without a body is not enough");
});
