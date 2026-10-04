// The Allocation tab RENDERED: AllocationBody / TargetRow / DemandForm rendered to static markup from props
// (test/tsxLoader.mjs compiles the .tsx), plus the awaited mutation outcome and the Retail-only routing. Effects
// and clicks are not run here; the decisions they apply are pure (allocationView.ts, settleDemandMutation).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api.ts";
import { AllocationBody, DemandForm, TargetRow, settleDemandMutation, targetAnchorId, type AllocationHandlers } from "../src/components/AllocationTab.tsx";
import { KEEP_ZERO_EXPLANATION, NO_TARGET_EXPLANATION, REMOVE_TARGET_EXPLANATION, UNPROVEN_VARIANTS_EXPLANATION, targetRowView, targetRowViews } from "../src/allocationView.ts";
import { defaultRoute, formatHash, parseHash, patchRoute } from "../src/routing.ts";
import { conflicting, demand, heldEntry, read, resolved, reviewData, unproven } from "./allocationFixtures.ts";

const render = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};
const handlers: AllocationHandlers = { onRetry: noop, onSearch: noop, onDemandedPage: noop, onUnallocatedPage: noop, onCreate: noop, onUpdate: noop, onDeactivate: noop };
type BodyProps = Parameters<typeof AllocationBody>[0];
const body = (props: Partial<BodyProps>) => render(createElement(AllocationBody, { version: "retail", status: "ready", query: "", busy: false, handlers, ...props }));
/** The markup between two headings (a section's own content). */
const section = (html: string, fromId: string, toId?: string) => html.slice(html.indexOf(fromId), toId ? html.indexOf(toId) : undefined);

const DATA = reviewData({
  unresolved: [{ scope: "character-bank", identityKey: "retail::cairne::groit" }, { scope: "character-bank", identityKey: "retail::cairne::hallo" }],
  demandedItems: [
    resolved({ id: 101, keep: 100, have: 40, purpose: "Alchemy", hasUnresolvedEvidence: true, reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, { code: "UNRESOLVED_STORAGE_PRESENT" }] }),
    unproven({ id: 102, keep: 0, seen: 3, identity: { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 3 } }),
    conflicting(103, ["demand_a", "demand_b"]),
    resolved({ id: 104, keep: 100, have: 117 }),
  ],
  itemNames: { "101": "Mycobloom", "102": "Prismatic Gem" },
  heldItems: [heldEntry({ id: 201, seen: 12, name: "Bismuth", potential: 8 }), heldEntry({ id: 202, seen: 3 })],
});
const DEMANDS = [demand(101, 100, { purpose: "Alchemy" }), demand(103, 100, { stableId: "demand_a", purpose: "Raid" }), demand(103, 20, { stableId: "demand_b" }), demand(301, 10, { stableId: "old", status: "INACTIVE", updatedAt: 1_790_000_500, purpose: "Old plan" })];

// --- states ------------------------------------------------------------------------------------------------------

test("loading: a placeholder, marked busy, with no target or held claims", () => {
  const html = body({ status: "loading" });
  assert.match(html, /aria-busy="true"/);
  assert.match(text(html), /Loading allocation…/);
  assert.doesNotMatch(text(html), /Your targets|No targets yet|Nothing held/);
});

test("error: the shared ErrorNotice with Retry, and no fabricated empty state", () => {
  const html = body({ status: "error", error: new ApiError("Can't reach the WoWSync server. Is it running?", "network") });
  assert.match(html, /role="alert"/);
  assert.match(text(html), /Can't reach the WoWSync server\. Is it running\? Retry/);
  assert.doesNotMatch(text(html), /No targets yet|Nothing held/);
});

test("non-Retail: the tab body says Retail-only and never renders Retail data; UNKNOWN provenance shows its reason", () => {
  assert.match(text(body({ version: "forever", read: read(DATA), demands: DEMANDS })), /Retail-only/);
  assert.doesNotMatch(text(body({ version: "forever", read: read(DATA) })), /Mycobloom/);
  const unknown = body({ read: { provenance: { state: "UNKNOWN", version: "retail", reason: "Explicit demand and allocation are Retail-only in this slice." } } });
  assert.match(text(unknown), /Explicit demand and allocation are Retail-only in this slice\./);
});

test("empty: no targets, and nothing held without a target (and a search with no match says so)", () => {
  const empty = text(body({ read: read(reviewData()), demands: [] }));
  assert.match(empty, /No targets yet\./);
  assert.match(empty, /Nothing held without a target\./);
  assert.match(text(body({ read: read(reviewData()), demands: [], query: "zzz" })), /No held item without a target matches “zzz”\./);
});

// --- the page wired to the view-model ----------------------------------------------------------------------------------

test("the page renders the view-model: every target row's summary is exactly allocationView's, in order, with an anchor", () => {
  const html = body({ read: read(DATA), demands: DEMANDS });
  const rows = targetRowViews(DATA, DEMANDS);
  let last = -1;
  for (const row of rows) {
    const at = text(html).indexOf(row.summary);
    assert.ok(at > last, `summary rendered in order: ${row.summary}`);
    last = at;
    assert.match(html, new RegExp(`id="${targetAnchorId(row.baseItemId)}"`));
  }
  const page = text(html);
  assert.match(page, /Keep 100 · Have 40 · Up to 60 short/);
  assert.match(page, /Up to 60 short; unseen storage could hold more\./);
  assert.match(page, /Keep 100 · Have 117 · 17 surplus/);
  assert.match(page, /Eligible for Hellomags/);
  assert.match(page, /Recommendation only\. Nothing is moved automatically\./);
  assert.match(page, /Why: Alchemy/);
});

test("account status appears once, from the review's unseen storage", () => {
  const page = text(body({ read: read(DATA), demands: DEMANDS }));
  const message = "2 character banks have not been observed, so surplus cannot currently be cleared for sale. Confirmed quantities remain usable.";
  assert.equal(page.split(message).length - 1, 1);
  assert.doesNotMatch(page, /Groit|Hallo/i, "no character is named in the status");
});

test("CONFLICTING_DEMAND is visible with its targets and per-target removal, and no arithmetic", () => {
  const html = body({ read: read(DATA), demands: DEMANDS });
  const row = html.slice(html.indexOf(targetAnchorId(103)), html.indexOf(targetAnchorId(104)));
  const t = text(row);
  assert.match(t, /2 active targets for this item · Allocation: not computed/);
  assert.match(t, /Keep 100 · Raid/);
  assert.match(t, /Keep 20/);
  assert.equal((row.match(/Remove this target/g) ?? []).length, 2);
  assert.doesNotMatch(t, /Short \d|\d+ surplus|Have \d/);
});

test("UNPROVEN renders 'Allocation: not computed' and its explanation, and never an arithmetic zero", () => {
  const html = body({ read: read(DATA), demands: DEMANDS });
  const row = html.slice(html.indexOf(targetAnchorId(102)), html.indexOf(targetAnchorId(103)));
  const t = text(row);
  assert.match(t, /Keep 0 · Seen 3 · 3 different versions of this item · Allocation: not computed/);
  assert.ok(t.includes(UNPROVEN_VARIANTS_EXPLANATION));
  assert.match(t, /Allocated not computed Short not computed Surplus not computed/);
  assert.doesNotMatch(t, /Allocated 0|Short 0|Surplus 0|Deficit 0|0 surplus/);
});

test("held with no target: says 'no target != surplus', names from evidence with ID fallback, LAST_SEEN separate, no surplus/disposition", () => {
  const html = body({ read: read(DATA), demands: DEMANDS });
  const held = section(html, "allocation-held-heading", "Removed targets");
  const t = text(held);
  assert.ok(t.includes(NO_TARGET_EXPLANATION));
  assert.match(t, /Bismuth Seen 12 \+8 last seen \(historical\)/);
  assert.match(t, /Item 202 \(name not observed\) Seen 3/);
  const rowsOnly = t.replace(NO_TARGET_EXPLANATION, "");
  assert.doesNotMatch(rowsOnly, /surplus|Hellomags|Short|Allocated|Needs review/i);
  assert.equal((held.match(/>Set target</g) ?? []).length, 2);
});

test("search: a labelled search input that keeps the current query, with Clear when searching", () => {
  const html = body({ read: read(DATA), demands: DEMANDS, query: "bis" });
  assert.match(html, /role="search"/);
  assert.match(html, /aria-label="Search held items"[^>]*value="bis"|value="bis"[^>]*aria-label="Search held items"/);
  assert.match(html, /placeholder="Search by item name or exact item ID"/);
  assert.match(text(html), /Clear/);
});

test("paging: previous/next controls for a long held list (the server's page, not a client slice)", () => {
  const items = Array.from({ length: 50 }, (_, i) => heldEntry({ id: 1000 + i, seen: 1 }));
  const data = reviewData({ heldItems: items });
  const html = body({ read: read({ ...data, unallocated: { ...data.unallocated, offset: 50, totalCount: 312, truncated: true } }), demands: [] });
  const t = text(html);
  assert.match(t, /← Previous 51–100 of 312 Next →/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>← Previous/);
  const first = text(body({ read: read({ ...data, unallocated: { ...data.unallocated, totalCount: 312, truncated: true } }), demands: [] }));
  assert.match(first, /1–50 of 312/);
});

test("create / add-by-ID: Set target on held rows and an item-ID form with the Keep explanation", () => {
  const html = body({ read: read(DATA), demands: DEMANDS });
  const byId = text(section(html, "allocation-byid-heading", "allocation-held-heading"));
  assert.match(byId, /Add a target by item ID/);
  assert.match(byId, /Item ID/);
  assert.match(byId, /Keep/);
  assert.match(byId, /Why \/ purpose \(optional\)/);
  assert.match(byId, /The account should hold N\. Anything confirmed beyond N can become surplus when the evidence is sufficient\./);
});

test("Keep 0 explanation shows for a 0 target, distinct from Remove target", () => {
  const t = text(render(createElement(DemandForm, { mode: "create", baseItemId: 5, initialKeep: "0", busy: false, onSubmit: noop })));
  assert.ok(t.includes(KEEP_ZERO_EXPLANATION));
});

test("edit and remove: Edit / Remove target controls; edit is prefilled with Keep N and purpose; remove explains that surplus becomes unknown", () => {
  const row = targetRowView(resolved({ id: 101, keep: 100, have: 40, purpose: "Alchemy" }), "Mycobloom");
  const view = render(createElement(TargetRow, { row, busy: false, focused: false, handlers }));
  assert.match(text(view), /Edit Remove target$/);
  const edit = render(createElement(TargetRow, { row, busy: false, focused: false, handlers, initialMode: "edit" }));
  assert.match(edit, /aria-label="Edit target"/);
  assert.match(edit, /value="100"/);
  assert.match(edit, /value="Alchemy"/);
  assert.match(text(edit), /Save target/);
  const remove = render(createElement(TargetRow, { row, busy: false, focused: false, handlers, initialMode: "remove" }));
  assert.ok(text(remove).includes(REMOVE_TARGET_EXPLANATION));
  assert.match(remove, /class="danger-button"[^>]*>Remove target</);
  const conflictRow = render(createElement(TargetRow, { row: targetRowView(conflicting(9, ["a", "b"]), "X"), busy: false, focused: false, handlers }));
  assert.doesNotMatch(text(conflictRow), /\bEdit\b/, "a conflict has no single demand to edit");
});

test("removed targets: a collapsed, read-only history with 'Set new target' (or a pointer to the current target)", () => {
  const html = body({ read: read(DATA), demands: [...DEMANDS, demand(101, 7, { stableId: "old101", status: "INACTIVE", updatedAt: 1 })] });
  const removed = section(html, "Removed targets");
  assert.match(html, /<details class="allocation-section allocation-removed">/);
  assert.doesNotMatch(html, /<details class="allocation-section allocation-removed" open/);
  const t = text(removed);
  assert.match(t, /Removed targets \(2\)/);
  assert.match(t, /Item 301 was Keep 10 · Old plan · removed/);
  assert.match(t, /Set new target/);
  assert.match(t, /Mycobloom was Keep 7 .*This item has a current target; edit it under Your targets\./);
  assert.doesNotMatch(t, /\bEdit\b(?! it under)|Reactivate/);
});

// --- mutation outcome: awaited, deterministic refresh ---------------------------------------------------------------

test("a mutation's refresh is decided only after the request settles: success reloads; a duplicate reloads and points at the existing target", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  let settled = false;
  const outcome = settleDemandMutation(() => pending, "Target set.").then((o) => ((settled = true), o));
  await Promise.resolve();
  assert.equal(settled, false, "nothing is decided while the request is in flight");
  release();
  assert.deepEqual(await outcome, { flash: { tone: "ok", message: "Target set." }, reload: true });

  const dup = await settleDemandMutation(() => Promise.reject(new ApiError("exists", "http", 409, "DEMAND_CONFLICT", { existingStableId: "demand_101" })), "x");
  assert.deepEqual(dup, { flash: { tone: "error", message: "This item already has a target. Edit it instead." }, reload: true, existingStableId: "demand_101" });
  const offline = await settleDemandMutation(() => Promise.reject(new ApiError("Can't reach the WoWSync server. Is it running?", "network")), "x");
  assert.equal(offline.reload, false);
});

test("the component reads semantics only through allocationView and never waits on a timer or defaults to zero", () => {
  const source = readFileSync(new URL("../src/components/AllocationTab.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/allocationView\.ts"/);
  assert.doesNotMatch(source, /setTimeout|setInterval/);
  assert.doesNotMatch(source, /\?\?\s*0\b|\|\|\s*0\b/);
  assert.doesNotMatch(source, /style=\{\{/);
  assert.doesNotMatch(source, /confirmedDeficit|confirmedSurplus|confirmedAvailable|confirmedQuantity|result\.allocated|\.resolution\b|\.disposition\b/, "no raw allocation result field is read in the component; it renders view-model cells");
  const view = readFileSync(new URL("../src/allocationView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(view, /\?\?\s*0\b|\|\|\s*0\b/);
});

// --- routing ------------------------------------------------------------------------------------------------------

test("routing: #/retail/allocation is a top-level tab view, and Allocation is moved to Retail like Shared Storage", () => {
  const parsed = parseHash("#/retail/allocation", "classic-era");
  assert.equal(parsed.version, "retail");
  assert.equal(parsed.view, "allocation");
  assert.equal(formatHash(parsed), "#/retail/allocation");
  const moved = patchRoute(defaultRoute("forever"), { view: "allocation" });
  assert.equal(moved.version, "retail");
  assert.equal(moved.view, "allocation");
  const typed = parseHash("#/forever/allocation", "retail");
  assert.equal(typed.view, "allocation", "a typed non-Retail hash parses like #/forever/shared does");
  assert.match(text(body({ version: typed.version, read: read(DATA) })), /Retail-only/, "and the tab body then shows Retail-only, never Retail data");
});

test("the Allocation tab button is only rendered for Retail, next to Shared Storage", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const retailOnly = app.slice(app.indexOf('{activeVersion === "retail" && ('), app.indexOf("Shared Storage"));
  assert.match(retailOnly, /view: "allocation"/);
  assert.match(retailOnly, /Allocation\s*<\/button>/);
});
