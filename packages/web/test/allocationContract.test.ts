// Cross-package contract tests for the Allocation tab. Nothing here is a hand-built allocation fixture: the
// review comes from the REAL core read model (DashboardReadModel over a SqliteSnapshotStore fed real export text)
// or the REAL server over HTTP, JSON-round-tripped exactly as the browser receives it, and is then passed through
// the web's hand-mirrored validator (isAllocationReviewRead) and the allocation view-model. Drift between core's
// output and the web mirror fails here.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, mock, test } from "node:test";
import { DashboardReadModel, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { renderExport, type ExportSpec } from "../../core/test/sharedStorageExports.ts";
import { T, fullRef, guildSection, observedSection, row, warbandSection } from "../../core/test/allocationFixtures.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../../server/src/net.ts";
import { createDemand, deactivateDemand, fetchAllocationReview, fetchDemands, isAllocationReviewRead } from "../src/api.ts";
import { accountStatusView, cellText, noTargetRowView, pageView, targetRowViews } from "../src/allocationView.ts";
import { INITIAL_PAGING, pagingReducer, type PagingState } from "../src/components/AllocationTab.tsx";
import type { AllocationReviewRead, ExplicitDemand } from "../src/types.ts";

afterEach(() => mock.restoreAll());

const HERB = 970001; // deficit, unseen storage, LAST_SEEN and guild context
const GEM = 970002; // two item-string variants -> BASE_ITEM_AGGREGATION_UNPROVEN
const SIGIL = 970003; // bound rows -> gated surplus
const ORE = 970004; // an unreported stack quantity -> unknown quantity
const LOOSE = 970005; // held, no target, no observed name

const ACCOUNT: ExportSpec = {
  name: "Anchor",
  generated: T,
  bags: observedSection([
    row(HERB, 40, { name: "Mycobloom" }),
    row(GEM, 2, { name: "Prismatic Gem", ref: fullRef(GEM, 1) }),
    row(GEM, 1, { name: "Prismatic Gem", ref: fullRef(GEM, 2) }),
    row(SIGIL, 9, { name: "Bound Sigil", bound: "yes" }),
    row(ORE, 5, { name: "Bismuth" }),
    row(ORE, undefined, { name: "Bismuth" }),
    row(LOOSE, 3, { name: null }),
  ]),
  // bank omitted: the addon's State: UNKNOWN -> unresolved account-owned storage
  warband: warbandSection("LAST_SEEN", [row(HERB, 8, { name: "Mycobloom" })]),
  guild: guildSection("gclub-contract", [row(HERB, 500, { name: "Mycobloom" })]),
};

function storeWith(exports: ExportSpec[]): SqliteSnapshotStore {
  const store = new SqliteSnapshotStore(":memory:");
  for (const spec of exports) store.importSnapshot(renderExport(spec));
  return store;
}

/** What the browser gets: the real ReadValue, serialized and parsed. */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("real read-model output (RESOLVED, UNPROVEN, unseen storage, unknown quantity, binding, LAST_SEEN, guild) passes the web validator and view-model", () => {
  const store = storeWith([ACCOUNT]);
  try {
    store.createDemand({ baseItemId: HERB, requiredQuantity: 100, purpose: "Alchemy" });
    store.createDemand({ baseItemId: GEM, requiredQuantity: 0 });
    store.createDemand({ baseItemId: SIGIL, requiredQuantity: 2 });
    const wire = overTheWire(new DashboardReadModel(store).getAllocationReview({ version: "retail", demandedLimit: 100, unallocatedLimit: 100 }));
    assert.ok(isAllocationReviewRead(wire), "the real core output satisfies the web's mirror");
    const data = (wire as AllocationReviewRead).data!;
    const demands = overTheWire(store.listDemands("retail")) as ExplicitDemand[];

    const rows = new Map(targetRowViews(data, demands).map((r) => [r.baseItemId, r]));
    const herb = rows.get(HERB)!;
    assert.equal(herb.state, "short");
    assert.equal(herb.title, "Mycobloom", "the itemNames sidecar names the row");
    assert.equal(herb.summary, "Keep 100 · Have 40 · Up to 60 short", "unseen storage makes the shortfall a ceiling");
    assert.equal(herb.lastSeen, "+8 last seen (historical)", "LAST_SEEN separate, never in Have");
    assert.deepEqual(herb.detail.guild.map((g) => g.text), ["500 · Guild-owned, not counted"]);
    assert.ok(herb.chips.some((c) => c.label === "Unseen storage"));

    const gem = rows.get(GEM)!;
    assert.equal(gem.state, "unproven");
    assert.equal(gem.summary, "Keep 0 · Seen 3 · 2 different versions of this item · Allocation: not computed");
    for (const cell of [gem.allocated, gem.short, gem.surplus]) assert.deepEqual(cell, { kind: "withheld", reason: "not computed" });

    const sigil = rows.get(SIGIL)!;
    assert.equal(sigil.state, "surplusReview");
    assert.equal(sigil.summary, "Keep 2 · Have 9 · At least 7 surplus · Needs review");
    assert.deepEqual(sigil.chips.map((c) => c.label), ["Unseen storage", "Bound"]);

    const held = new Map(data.unallocated.items.map((e) => [e.baseItemId, noTargetRowView(e)]));
    assert.equal(`Seen ${cellText(held.get(ORE)!.seen)}`, "Seen ≥ 5", "an unreported stack makes the observed count a floor");
    assert.ok(held.get(ORE)!.chips.some((c) => c.label === "Unknown quantity"));
    assert.equal(held.get(LOOSE)!.title, `Item ${LOOSE}`, "no observed name falls back to the item ID");
    for (const view of held.values()) assert.doesNotMatch(JSON.stringify(view), /surplus|disposition|Hellomags/i);

    assert.equal(accountStatusView(data).tone, "unresolved");
    assert.match(accountStatusView(data).message, /1 character bank has not been observed/);
  } finally {
    store.close();
  }
});

test("real non-Retail output (UNKNOWN provenance, no data) passes the validator; drift in a real result is rejected", () => {
  const store = storeWith([ACCOUNT]);
  try {
    store.createDemand({ baseItemId: HERB, requiredQuantity: 100 });
    assert.ok(isAllocationReviewRead(overTheWire(new DashboardReadModel(store).getAllocationReview({ version: "classic-era" }))));
    const wire = overTheWire(new DashboardReadModel(store).getAllocationReview({ version: "retail" })) as { data: { demanded: { items: Array<Record<string, unknown>> } } };
    delete wire.data.demanded.items[0]!.confirmedDeficit;
    assert.equal(isAllocationReviewRead(wire), false, "a real RESOLVED result missing its arithmetic is a shape error");
  } finally {
    store.close();
  }
});

// --- stale paging offset, end to end over real HTTP -----------------------------------------------------------------

async function withHttp(exports: ExportSpec[], run: (store: SqliteSnapshotStore) => Promise<void>) {
  const store = storeWith(exports);
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  // The web client requests relative /api paths, as in the browser; send them to this real server.
  mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => realFetch(`${base}${String(input)}`, init));
  try {
    await run(store);
  } finally {
    mock.restoreAll();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

/** One read for the current paging state, exactly as the tab issues it. */
const readFor = (state: PagingState) =>
  fetchAllocationReview("retail", { demandedOffset: state.demandedOffset, demandedLimit: 50, unallocatedOffset: state.unallocatedOffset, unallocatedLimit: 50, q: state.query });

test("stale offset (held list): setting a target on the only row of page 2 leaves offset 50 past the end; the tab recovers to page 1 and loads the 50 rows", async () => {
  const items = Array.from({ length: 51 }, (_, i) => row(980000 + i, 1, { name: `Held ${i}` }));
  await withHttp([{ name: "Anchor", generated: T, bags: observedSection(items), bank: observedSection([]), warband: warbandSection("OBSERVED", []) }], async () => {
    let state = pagingReducer(INITIAL_PAGING, { type: "unallocatedPage", offset: 50 });
    const page2 = await readFor(state);
    assert.deepEqual(page2.data!.unallocated.items.map((e) => e.baseItemId), [980050]);

    await createDemand("retail", { baseItemId: 980050, requiredQuantity: 1 });
    state = pagingReducer(state, { type: "reload" });
    const stale = await readFor(state);
    assert.equal(stale.data!.unallocated.items.length, 0);
    assert.equal(stale.data!.unallocated.totalCount, 50, "50 matching rows still exist");
    assert.equal(pageView(stale.data!.unallocated).pastEnd, true, "shown as past the end, not as empty");

    state = pagingReducer(state, { type: "loaded", data: stale.data! });
    assert.equal(state.unallocatedOffset, 0);
    const recovered = await readFor(state);
    assert.equal(recovered.data!.unallocated.items.length, 50);
    assert.equal(recovered.data!.unallocated.items[0]!.baseItemId, 980000);
    assert.equal(pagingReducer(state, { type: "loaded", data: recovered.data! }), state, "settled: no further reload");
  });
});

test("stale offset (targets): removing the only target on page 2 recovers to page 1; a search narrows and starts at page 1", async () => {
  const held = Array.from({ length: 60 }, (_, i) => row(990000 + i, 1, { name: i < 3 ? `Ore ${i}` : `Cloth ${i}` }));
  await withHttp([{ name: "Anchor", generated: T, bags: observedSection(held), bank: observedSection([]), warband: warbandSection("OBSERVED", []) }], async (store) => {
    for (let i = 0; i < 51; i++) store.createDemand({ baseItemId: 995000 + i, requiredQuantity: 10 });
    let state = pagingReducer(INITIAL_PAGING, { type: "demandedPage", offset: 50 });
    const page2 = await readFor(state);
    const last = page2.data!.demanded.items[0]!;
    assert.equal(page2.data!.demanded.items.length, 1);
    assert.ok(last.resolution === "RESOLVED");

    await deactivateDemand("retail", last.demand.stableId);
    state = pagingReducer(state, { type: "reload" });
    const stale = await readFor(state);
    assert.deepEqual([stale.data!.demanded.items.length, stale.data!.demanded.totalCount], [0, 50]);
    state = pagingReducer(state, { type: "loaded", data: stale.data! });
    assert.equal(state.demandedOffset, 0);
    assert.equal((await readFor(state)).data!.demanded.items.length, 50);
    assert.ok((await fetchDemands("retail")).demands.some((d) => d.stableId === last.demand.stableId && d.status === "INACTIVE"));

    // Search from a later held page: the query starts at page 1 of the matches, deterministically.
    state = pagingReducer(state, { type: "unallocatedPage", offset: 50 });
    state = pagingReducer(state, { type: "search", q: "ore" });
    const matches = await readFor(state);
    assert.deepEqual([state.unallocatedOffset, matches.data!.unallocated.totalCount, matches.data!.unallocated.items.length], [0, 3, 3]);
  });
});
