// The Allocation tab's semantic view-model (allocationView.ts): every allocation result state presented from the
// fields that variant actually carries. The central claims: "Keep N" is the target, absent arithmetic is never a
// zero, LAST_SEEN is never added to Have/Seen, and no-target rows carry no surplus or disposition at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import {
  CONFLICT_EXPLANATION,
  DUPLICATE_TARGET_MESSAGE,
  KEEP_ZERO_EXPLANATION,
  NOT_COMPUTED,
  RECOMMENDATION_ONLY,
  UNPROVEN_INCOMPLETE_EXPLANATION,
  UNPROVEN_VARIANTS_EXPLANATION,
  accountStatusView,
  cellText,
  characterLabel,
  describeDemandError,
  keepHelp,
  knownNames,
  noTargetRowView,
  pageView,
  recoveryOffset,
  parseItemId,
  parseKeepQuantity,
  removedTargetViews,
  targetRowView,
  targetRowViews,
  type Cell,
  type TargetRowView,
} from "../src/allocationView.ts";
import { conflicting, demand, heldEntry, resolved, reviewData, unproven } from "./allocationFixtures.ts";

const STORAGE_UNKNOWN = { code: "UNRESOLVED_STORAGE_PRESENT", detail: "Unresolved account-owned storage scope(s): character-bank." };
const QTY_UNKNOWN = { code: "ITEM_QUANTITY_UNKNOWN_PRESENT", detail: "Observed account-owned storage holds item row(s) with unreported quantity." };
const isNumeric = (cell: Cell) => cell.kind === "numeric";
const allText = (row: TargetRowView) => [row.summary, row.status.label, ...row.notes, ...row.chips.map((c) => c.label), row.lastSeen ?? "", cellText(row.keep), cellText(row.have), cellText(row.allocated), cellText(row.short), cellText(row.surplus)].join(" | ");

test("Keep N is the demand's requiredQuantity, never the allocated quantity", () => {
  const row = targetRowView(resolved({ id: 1, keep: 100, have: 40 }), "Dreamleaf");
  assert.deepEqual(row.keep, { kind: "numeric", value: 100, bound: "exact" });
  assert.deepEqual(row.allocated, { kind: "numeric", value: 40, bound: "exact" });
  assert.match(row.summary, /^Keep 100 · Have 40/);
  assert.doesNotMatch(row.summary, /Keep 40/);
});

test("deficit: Keep 100 · Have 40 · Short 60, HOLD", () => {
  const row = targetRowView(resolved({ id: 1, keep: 100, have: 40 }), "Dreamleaf");
  assert.equal(row.state, "short");
  assert.equal(row.summary, "Keep 100 · Have 40 · Short 60");
  assert.deepEqual(row.short, { kind: "numeric", value: 60, bound: "exact" });
  assert.equal(row.surplus.kind, "notApplicable");
  assert.deepEqual(row.notes, []);
  assert.equal(row.title, "Dreamleaf");
});

test("deficit with unseen storage: 'Up to 60 short; unseen storage could hold more.' and an Unseen storage chip", () => {
  const row = targetRowView(resolved({ id: 1, keep: 100, have: 40, hasUnresolvedEvidence: true, reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, { code: "CONFIRMED_INVENTORY_BELOW_DEMAND" }, STORAGE_UNKNOWN] }), "Dreamleaf");
  assert.equal(row.summary, "Keep 100 · Have 40 · Up to 60 short");
  assert.deepEqual(row.notes, ["Up to 60 short; unseen storage could hold more."]);
  assert.deepEqual(row.short, { kind: "numeric", value: 60, bound: "atMost" });
  assert.equal(cellText(row.short), "up to 60");
  assert.deepEqual(row.chips.map((c) => c.label), ["Unseen storage"]);
});

test("exact: Keep 100 · Have 100 · On target, no uncertainty nagging when unseen storage cannot change the outcome", () => {
  const row = targetRowView(resolved({ id: 1, keep: 100, have: 100, hasUnresolvedEvidence: true, reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, STORAGE_UNKNOWN] }), "X");
  assert.equal(row.state, "onTarget");
  assert.equal(row.summary, "Keep 100 · Have 100 · On target");
  assert.deepEqual(row.chips, [], "the account-level status covers unseen storage; this row's outcome is not affected");
});

test("confirmed surplus eligible: '17 surplus', Eligible for Hellomags, explicitly a recommendation only", () => {
  const row = targetRowView(resolved({ id: 1, keep: 100, have: 117 }), "X");
  assert.equal(row.state, "surplusEligible");
  assert.equal(row.summary, "Keep 100 · Have 117 · 17 surplus");
  assert.equal(row.status.label, "Eligible for Hellomags");
  assert.ok(row.notes.includes(RECOMMENDATION_ONLY));
  assert.deepEqual(row.surplus, { kind: "numeric", value: 17, bound: "exact" });
});

test("surplus gated by unseen storage: 'At least 17 surplus · Needs review', a floor, never cleared for sale", () => {
  const row = targetRowView(
    resolved({ id: 1, keep: 100, have: 117, hasUnresolvedEvidence: true, disposition: "REQUIRES_REVIEW", reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, STORAGE_UNKNOWN, { code: "SURPLUS_CONFIRMED" }, { code: "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE" }] }),
    "X",
  );
  assert.equal(row.state, "surplusReview");
  assert.equal(row.summary, "Keep 100 · Have 117 · At least 17 surplus · Needs review");
  assert.deepEqual(row.surplus, { kind: "numeric", value: 17, bound: "atLeast" });
  assert.ok(row.chips.some((c) => c.label === "Unseen storage"));
  assert.doesNotMatch(allText(row), /Eligible for Hellomags/);
});

test("binding gate: Bound chip, exact surplus (binding is not unresolved evidence), Needs review", () => {
  const row = targetRowView(
    resolved({ id: 1, keep: 2, have: 9, disposition: "REQUIRES_REVIEW", facets: { confirmedBinding: { boundRowCount: 1, unboundRowCount: 0, unknownRowCount: 0 } }, reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, { code: "BOUND_INVENTORY_PRESENT" }, { code: "SURPLUS_CONFIRMED" }, { code: "SALE_DISPOSITION_GATED_BY_BINDING" }] }),
    "X",
  );
  assert.deepEqual(row.chips.map((c) => c.label), ["Bound"]);
  assert.equal(row.summary, "Keep 2 · Have 9 · 7 surplus · Needs review");
  assert.ok(row.notes.some((n) => /bound or have unknown binding/.test(n)));
  assert.match(row.detail.binding!, /soulbound and Warbound are not distinguished/);
});

test("binding unknown gate: Binding unknown chip", () => {
  const row = targetRowView(resolved({ id: 1, keep: 2, have: 9, disposition: "REQUIRES_REVIEW", facets: { confirmedBinding: { boundRowCount: 0, unboundRowCount: 0, unknownRowCount: 3 } }, reasons: [{ code: "BINDING_UNKNOWN_PRESENT" }, { code: "SALE_DISPOSITION_GATED_BY_BINDING" }] }), "X");
  assert.deepEqual(row.chips.map((c) => c.label), ["Binding unknown"]);
  assert.match(row.detail.binding!, /3 binding unknown/);
});

test("an active ERP project reservation blocks the sale recommendation and explains the plan conflict", () => {
  const row = targetRowView(resolved({ id: 1, keep: 2, have: 9, disposition: "REQUIRES_REVIEW", reasons: [{ code: "EXPLICIT_DEMAND_EXISTS" }, { code: "SURPLUS_CONFIRMED" }, { code: "PROJECT_RESERVATION_GATES_SALE", detail: "Reserve for a craft has 5 units reserved." }] }), "X");
  assert.equal(row.state, "surplusReview");
  assert.doesNotMatch(allText(row), /Eligible for Hellomags/);
  assert.ok(row.notes.some((note) => /active project reservation overlaps this item/i.test(note)));
});

test("bound=no is never presented as tradeable, transferable, or sale-certified", () => {
  const row = targetRowView(resolved({ id: 1, keep: 1, have: 5, facets: { confirmedBinding: { boundRowCount: 0, unboundRowCount: 4, unknownRowCount: 0 } } }), "X");
  const held = noTargetRowView(heldEntry({ id: 2, seen: 4, facets: { confirmedBinding: { boundRowCount: 0, unboundRowCount: 4, unknownRowCount: 0 } } }));
  const everything = JSON.stringify([row, held]);
  assert.doesNotMatch(everything, /\btradeable\b|\btradable\b|\btransferable\b|\bmailable\b|sale-eligible/i);
  assert.match(row.detail.binding!, /not reported bound \(this does not prove it can be traded or moved\)/);
  assert.equal(row.chips.length, 0, "no chip claims anything about unbound rows");
});

test("UNPROVEN (variants): Keep 0 · Seen 3 · 3 different versions · Allocation: not computed; arithmetic cells withheld, never zero", () => {
  const row = targetRowView(unproven({ id: 1, keep: 0, seen: 3, identity: { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 3 } }), "Gem");
  assert.equal(row.state, "unproven");
  assert.equal(row.summary, "Keep 0 · Seen 3 · 3 different versions of this item · Allocation: not computed");
  assert.equal(row.status.label, "Needs review");
  for (const cell of [row.allocated, row.short, row.surplus]) assert.deepEqual(cell, { kind: "withheld", reason: NOT_COMPUTED });
  assert.deepEqual(row.keep, { kind: "numeric", value: 0, bound: "exact" });
  assert.deepEqual(row.have, { kind: "numeric", value: 3, bound: "exact" });
  assert.ok(row.notes.includes(UNPROVEN_VARIANTS_EXPLANATION));
  assert.doesNotMatch(allText(row), /Allocated 0|Short 0|Deficit 0|Surplus 0|0 surplus/);
  assert.doesNotMatch(JSON.stringify(row), /item:\d+:/, "raw item strings are not exposed");
});

test("UNPROVEN (incomplete identity): explained as insufficient item-string identity evidence", () => {
  const row = targetRowView(unproven({ id: 1, keep: 5, seen: 2, identity: { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount: 0 } }), undefined);
  assert.ok(row.notes.includes(UNPROVEN_INCOMPLETE_EXPLANATION));
  assert.match(row.summary, /Incomplete item identity · Allocation: not computed/);
  assert.equal(row.title, "Item 1");
});

test("absent arithmetic never becomes a number: UNPROVEN, CONFLICTING and NO_ACTIVE_DEMAND rows have no numeric allocated/short/surplus", () => {
  const rows = [
    targetRowView(unproven({ id: 1, keep: 4, seen: 3, identity: { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 } }), "a"),
    targetRowView(conflicting(2, ["demand_a", "demand_b"]), "b"),
    targetRowView({ ...conflicting(3, []), resolution: "NO_ACTIVE_DEMAND", disposition: "NO_ACTION" } as never, "c"),
  ];
  for (const row of rows) for (const cell of [row.allocated, row.short, row.surplus]) assert.ok(!isNumeric(cell), `${row.state}: ${JSON.stringify(cell)}`);
});

test("CONFLICTING_DEMAND stays visible, names its targets from loaded records, and invents no arithmetic", () => {
  const demands = [demand(7, 100, { stableId: "demand_a", purpose: "Raid" }), demand(7, 20, { stableId: "demand_b" })];
  const row = targetRowView(conflicting(7, ["demand_a", "demand_b", "demand_unknown"]), "Flask", demands);
  assert.equal(row.state, "conflict");
  assert.equal(row.demand, undefined, "no single editable demand");
  assert.deepEqual(row.conflict, [{ stableId: "demand_a", requiredQuantity: 100, purpose: "Raid" }, { stableId: "demand_b", requiredQuantity: 20 }, { stableId: "demand_unknown" }]);
  assert.ok(row.notes.includes(CONFLICT_EXPLANATION));
  assert.equal(row.keep.kind, "withheld");
  assert.equal(row.have.kind, "withheld", "Have is not recomputed client-side");
  assert.match(row.summary, /3 active targets for this item · Allocation: not computed/);
});

test("LAST_SEEN is a separate historical line and never added to Have/Seen", () => {
  const row = targetRowView(resolved({ id: 1, keep: 10, have: 4, potential: 8, evidence: [{ scope: "character-bags", admissibility: "CONFIRMED", quantity: 4 }, { scope: "warband", admissibility: "POTENTIAL", quantity: 8 }] }), "X");
  assert.deepEqual(row.have, { kind: "numeric", value: 4, bound: "exact" });
  assert.equal(row.summary, "Keep 10 · Have 4 · Short 6");
  assert.equal(row.lastSeen, "+8 last seen (historical)");
  assert.deepEqual(row.detail.lastSeen.map((l) => [l.label, l.text]), [["Warband bank", "8"]]);
  const held = noTargetRowView(heldEntry({ id: 2, seen: 3, potential: 5, potentialUnknownRows: 1 }));
  assert.deepEqual(held.seen, { kind: "numeric", value: 3, bound: "exact" });
  assert.equal(held.lastSeen, "+5 or more last seen (historical; some quantities unknown)");
});

test("UNKNOWN is never zero or empty: unknown stack quantities give a lower bound; whole unseen storage is stated, not counted", () => {
  const row = targetRowView(
    resolved({ id: 1, keep: 20, have: 12, hasUnresolvedEvidence: true, reasons: [QTY_UNKNOWN], evidence: [{ scope: "character-bags", admissibility: "CONFIRMED", quantity: 12, unknownQuantityRowCount: 1, identityKey: "retail::cairne::anchor" }, { scope: "character-bags", admissibility: "UNRESOLVED", unresolvedCause: "ITEM_QUANTITY_UNKNOWN", identityKey: "retail::cairne::anchor" }] }),
    "X",
  );
  assert.equal(cellText(row.have), "≥ 12");
  assert.equal(row.summary, "Keep 20 · Have ≥ 12 · Up to 8 short");
  assert.ok(row.chips.some((c) => c.label === "Unknown quantity"));
  assert.deepEqual(row.detail.confirmed.map((l) => l.text), ["12 + 1 stack of unknown quantity"]);
  assert.equal(row.detail.unresolved.length, 1);
  assert.doesNotMatch(JSON.stringify(row.detail.unresolved), /"0"|: 0\b/);

  const held = noTargetRowView(heldEntry({ id: 2, seen: 12, holdings: [{ scope: "character-bank", admissibility: "CONFIRMED", quantity: 12, unknownQuantityRowCount: 2 }, { scope: "character-bank", admissibility: "UNRESOLVED", unresolvedCause: "ITEM_QUANTITY_UNKNOWN" }] }));
  assert.equal(`Seen ${cellText(held.seen)}`, "Seen ≥ 12");

  const status = accountStatusView({ unresolvedStorage: [{ scope: "character-bank", identityKey: "retail::r::a" }, { scope: "character-bank", identityKey: "retail::r::b" }], unidentifiedItemRowCount: 0 });
  assert.equal(status.tone, "unresolved");
  assert.equal(status.message, "Counts are based on observed storage. 2 character banks have not been observed, so surplus cannot currently be cleared for sale. Confirmed quantities remain usable.");
  assert.doesNotMatch(status.message, /log in|open (every|each)|visit/i, "not a chore prompt");
});

test("account status: built from real scopes (bags, Warband), clear when nothing is unseen, and reports unidentified rows", () => {
  assert.match(accountStatusView({ unresolvedStorage: [{ scope: "warband" }], unidentifiedItemRowCount: 0 }).message, /The Warband bank has not been observed/);
  assert.match(accountStatusView({ unresolvedStorage: [{ scope: "character-bags", identityKey: "x" }, { scope: "character-bank", identityKey: "x" }, { scope: "warband" }], unidentifiedItemRowCount: 0 }).message, /1 character bank, 1 character's bags and the Warband bank have not been observed/);
  const clear = accountStatusView({ unresolvedStorage: [], unidentifiedItemRowCount: 2 });
  assert.equal(clear.tone, "clear");
  assert.match(clear.unidentifiedNote!, /2 held rows could not be identified/);
});

test("no-target rows carry no surplus, deficit, allocation or disposition semantics", () => {
  const view = noTargetRowView(heldEntry({ id: 5, seen: 40, name: "Mycobloom", facets: { confirmedItemStringIdentity: { class: "ITEM_STRING_VARIANTS", distinctItemStringCount: 2 }, confirmedBinding: { boundRowCount: 1, unboundRowCount: 0, unknownRowCount: 0 } } }));
  for (const key of ["surplus", "short", "allocated", "keep", "disposition", "status", "state", "demand"]) assert.ok(!(key in view), `no ${key}`);
  assert.doesNotMatch(JSON.stringify(view), /surplus|Hellomags|disposition/i);
  assert.deepEqual(view.chips.map((c) => c.label), ["2 versions", "Bound"]);
  assert.equal(view.title, "Mycobloom");
});

test("item names: the demanded sidecar names target rows; unknown names fall back to the item ID", () => {
  const data = reviewData({ demandedItems: [resolved({ id: 11, keep: 1, have: 1 }), resolved({ id: 12, keep: 1, have: 1 })], itemNames: { "11": "Named" }, heldItems: [heldEntry({ id: 13, seen: 1 })] });
  assert.deepEqual(targetRowViews(data).map((r) => [r.title, r.nameKnown]), [["Named", true], ["Item 12", false]]);
  assert.deepEqual(noTargetRowView(data.unallocated.items[0]!).title, "Item 13");
});

test("guild context is detail only and labelled guild-owned, not counted", () => {
  const row = targetRowView(resolved({ id: 1, keep: 10, have: 0, guildContext: [{ ownerKey: "retail::guild::g", admissibility: "CONFIRMED", quantity: 500 }], evidence: [] }), "X");
  assert.equal(row.summary, "Keep 10 · Have 0 · Short 10");
  assert.deepEqual(row.detail.guild.map((g) => g.text), ["500 · Guild-owned, not counted"]);
  assert.doesNotMatch(row.summary + row.notes.join(" "), /500|guild/i);
});

test("removed targets: INACTIVE only, newest first, read-only, and a current target blocks a second", () => {
  const demands = [
    demand(1, 10, { stableId: "old_a", status: "INACTIVE", updatedAt: 5, purpose: "was raid" }),
    demand(2, 3, { stableId: "old_b", status: "INACTIVE", updatedAt: 9 }),
    demand(1, 40, { stableId: "now_a" }),
  ];
  const views = removedTargetViews(demands, { "1": "Flask" });
  assert.deepEqual(views.map((v) => [v.stableId, v.title, v.requiredQuantity, v.hasActiveTarget]), [["old_b", "Item 2", 3, false], ["old_a", "Flask", 10, true]]);
  assert.equal(views[1]!.purpose, "was raid");
  assert.deepEqual(knownNames(reviewData({ itemNames: { "1": "A" }, heldItems: [heldEntry({ id: 2, seen: 1, name: "B" })] })), { "1": "A", "2": "B" });
});

test("Keep input: whole numbers >= 0, 0 explained as 'want none', distinct from Remove target", () => {
  assert.deepEqual(parseKeepQuantity("0"), { value: 0 });
  assert.deepEqual(parseKeepQuantity(" 100 "), { value: 100 });
  for (const bad of ["", "-1", "1.5", "abc", "1e3"]) assert.ok("error" in parseKeepQuantity(bad), bad);
  assert.equal(keepHelp("0"), KEEP_ZERO_EXPLANATION);
  assert.match(KEEP_ZERO_EXPLANATION, /Keep 0 means you want none of this/);
  assert.match(KEEP_ZERO_EXPLANATION, /different from Remove target/);
  assert.match(keepHelp("100"), /The account should hold 100\. Anything confirmed beyond 100 can become surplus/);
  assert.deepEqual(parseItemId("12345"), { value: 12345 });
  for (const bad of ["0", "", "x", "-4"]) assert.ok("error" in parseItemId(bad), bad);
});

test("duplicate-target error maps to 'already has a target, edit it instead' with the existing id; stale-state errors ask for a reload", () => {
  const dup = describeDemandError(new ApiError("An active demand already exists", "http", 409, "DEMAND_CONFLICT", { code: "DEMAND_CONFLICT", existingStableId: "demand_x" }));
  assert.deepEqual(dup, { message: DUPLICATE_TARGET_MESSAGE, existingStableId: "demand_x", refresh: true });
  assert.equal(describeDemandError(new ApiError("inactive", "http", 409, "DEMAND_INACTIVE")).refresh, true);
  assert.equal(describeDemandError(new ApiError("gone", "http", 404, "DEMAND_NOT_FOUND")).refresh, true);
  const network = describeDemandError(new ApiError("Can't reach the WoWSync server. Is it running?", "network"));
  assert.deepEqual(network, { message: "Can't reach the WoWSync server. Is it running?", refresh: false });
  assert.equal(describeDemandError(new ApiError("requiredQuantity must be a non-negative integer.", "http", 400, "INVALID_REQUIRED_QUANTITY")).message, "requiredQuantity must be a non-negative integer.");
});

test("paging view: range text and previous/next offsets only where they exist", () => {
  assert.deepEqual(pageView({ items: [1, 2], offset: 0, limit: 2, totalCount: 5 }), { text: "1–2 of 5", nextOffset: 2, pastEnd: false });
  assert.deepEqual(pageView({ items: [1, 2], offset: 2, limit: 2, totalCount: 5 }), { text: "3–4 of 5", prevOffset: 0, nextOffset: 4, pastEnd: false });
  assert.deepEqual(pageView({ items: [1], offset: 4, limit: 2, totalCount: 5 }), { text: "5–5 of 5", prevOffset: 2, pastEnd: false });
  assert.deepEqual(pageView({ items: [], offset: 0, limit: 2, totalCount: 0 }), { text: "0 of 0", pastEnd: false });
});

test("stale offset: a page past the end of existing rows is never 'empty' and offers the last valid page", () => {
  // The review's example: the last row of page 2 moved away, so offset 50 now holds nothing while 50 rows exist.
  const stale = { items: [], offset: 50, limit: 50, totalCount: 50 };
  assert.equal(recoveryOffset(stale), 0);
  assert.deepEqual(pageView(stale), { text: "No rows on this page · 50 in total", prevOffset: 0, pastEnd: true });
  assert.equal(recoveryOffset({ items: [], offset: 300, limit: 50, totalCount: 120 }), 100, "the LAST valid page, not the first");
  assert.equal(recoveryOffset({ items: [], offset: 200, limit: 100, totalCount: 101 }), 100, "uses the server's own limit");
  assert.equal(recoveryOffset({ items: [], offset: 0, limit: 50, totalCount: 0 }), undefined, "genuinely empty stays empty");
  assert.equal(recoveryOffset({ items: [1], offset: 50, limit: 50, totalCount: 51 }), undefined);
});

test("character labels from identity keys", () => {
  assert.equal(characterLabel("retail::cairne::anchor"), "Anchor (Cairne)");
  assert.equal(characterLabel("odd"), "odd");
});
