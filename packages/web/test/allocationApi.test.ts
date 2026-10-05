// The web client seam for the Allocation tab: request paths/bodies for the review and demand mutations, reply
// validation (an unknown allocation resolution is a shape error, never rendered by guesswork), and the 409
// duplicate-target error. fetch is stubbed; nothing touches a network.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { ApiError, createDemand, deactivateDemand, fetchAllocationReview, fetchDemands, isAllocationReviewRead, updateDemand } from "../src/api.ts";
import { conflicting, read, resolved, reviewData, unproven } from "./allocationFixtures.ts";

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
const OK_READ = read(reviewData({ demandedItems: [resolved({ id: 1, keep: 2, have: 1 }), unproven({ id: 2, keep: 0, seen: 3, identity: { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 3 } }), conflicting(3, ["a", "b"])] }));

async function failure(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err));
    return err;
  }
  assert.fail("expected a failure");
}

test("fetchAllocationReview: GET with paging and a trimmed search; a blank search is not sent", async () => {
  const calls = stubFetch(() => json(OK_READ));
  await fetchAllocationReview("retail", { demandedOffset: 50, demandedLimit: 50, unallocatedOffset: 0, unallocatedLimit: 50, q: "  heart " });
  assert.equal(calls[0]!.url, "/api/versions/retail/allocation-review?demandedOffset=50&demandedLimit=50&unallocatedOffset=0&unallocatedLimit=50&q=heart");
  await fetchAllocationReview("retail", { q: "   " });
  assert.equal(calls[1]!.url, "/api/versions/retail/allocation-review");
});

test("the reply check accepts every known result variant and UNKNOWN provenance without data", async () => {
  assert.equal(isAllocationReviewRead(OK_READ), true);
  assert.equal(isAllocationReviewRead({ provenance: { state: "UNKNOWN", version: "forever", reason: "Retail-only" } }), true);
});

test("an unknown resolution (a future semantic) is a shape error, never rendered", async () => {
  const future = read(reviewData({ demandedItems: [{ ...resolved({ id: 1, keep: 2, have: 1 }), resolution: "PARTIALLY_RESERVED" } as never] }));
  assert.equal(isAllocationReviewRead(future), false);
  stubFetch(() => json(future));
  assert.equal((await failure(() => fetchAllocationReview("retail"))).kind, "shape");
});

test("a variant missing the arithmetic it must carry is a shape error (nothing is defaulted to zero)", () => {
  const { confirmedSurplus: _drop, ...noSurplus } = resolved({ id: 1, keep: 2, have: 5 });
  assert.equal(isAllocationReviewRead(read(reviewData({ demandedItems: [noSurplus as never] }))), false);
  const { confirmedQuantity: _q, ...noSeen } = unproven({ id: 2, keep: 0, seen: 3, identity: { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount: 0 } });
  assert.equal(isAllocationReviewRead(read(reviewData({ demandedItems: [noSeen as never] }))), false);
  for (const bad of [{}, { data: {} }, { provenance: {} }, { provenance: { state: "DERIVED" }, data: { demanded: {}, unallocated: {} } }]) assert.equal(isAllocationReviewRead(bad), false, JSON.stringify(bad));
});

test("create sends one STOCK_TARGET with the quantity (0 included) and a trimmed purpose; a blank purpose is omitted", async () => {
  const calls = stubFetch(() => json({ demand: { stableId: "d" } }, 201));
  await createDemand("retail", { baseItemId: 12345, requiredQuantity: 0, purpose: "  none of this " });
  await createDemand("retail", { baseItemId: 9, requiredQuantity: 100, purpose: "   " });
  assert.equal(calls[0]!.url, "/api/versions/retail/demands");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { demandType: "STOCK_TARGET", baseItemId: 12345, requiredQuantity: 0, purpose: "none of this" });
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { demandType: "STOCK_TARGET", baseItemId: 9, requiredQuantity: 100 });
});

test("edit PATCHes quantity and purpose of one demand; remove POSTs deactivate (never DELETE)", async () => {
  const calls = stubFetch(() => json({ demand: { stableId: "demand_1" } }));
  await updateDemand("retail", "demand_1", { requiredQuantity: 25, purpose: " Raid " });
  await deactivateDemand("retail", "demand_1");
  assert.equal(calls[0]!.url, "/api/versions/retail/demands/demand_1");
  assert.equal(calls[0]!.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { requiredQuantity: 25, purpose: "Raid" });
  assert.equal(calls[1]!.url, "/api/versions/retail/demands/demand_1/deactivate");
  assert.equal(calls[1]!.init?.method, "POST");
  assert.ok(calls.every((c) => c.init?.method !== "DELETE"));
});

test("a duplicate target surfaces as ApiError 409 DEMAND_CONFLICT carrying existingStableId", async () => {
  stubFetch(() => json({ error: "An active demand already exists", code: "DEMAND_CONFLICT", existingStableId: "demand_existing" }, 409));
  const err = await failure(() => createDemand("retail", { baseItemId: 1, requiredQuantity: 1 }));
  assert.equal(err.status, 409);
  assert.equal(err.code, "DEMAND_CONFLICT");
  assert.equal((err.details as { existingStableId: string }).existingStableId, "demand_existing");
});

test("fetchDemands reads every demand (any status) for the version", async () => {
  const calls = stubFetch(() => json({ demands: [] }));
  assert.deepEqual(await fetchDemands("retail"), { demands: [] });
  assert.equal(calls[0]!.url, "/api/versions/retail/demands");
});
