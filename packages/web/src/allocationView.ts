// The Allocation tab's semantic presentation layer (pure; no React, no fetch). Every allocation meaning the
// tab shows is decided here, from the read model's own result variants, and rendered by AllocationTab.tsx.
//
// Rules this module enforces (see docs/AZEROTH_ERP_ARCHITECTURE.md):
//   - A quantity cell is typed: `numeric` (a value the server actually computed, possibly a floor/ceiling),
//     `withheld` (the arithmetic does not exist for this result, with the reason), or `notApplicable`. A value
//     the server did not send is never read as 0; there is no fallback-to-zero anywhere in this file.
//   - "Keep N" is always the demand's requiredQuantity, never `allocated`.
//   - LAST_SEEN quantities are a separate, historical line; they are never added to Have/Seen.
//   - Held-with-no-target rows carry no surplus, deficit, or disposition at all: no target means surplus is unknown.
//   - Binding is the client's captured evidence only: bound=no is never presented as tradeable or transferable,
//     and bound=yes is never narrowed to soulbound/Warbound.
//   - Guild-owned evidence is context ("Guild-owned, not counted"), never part of any number.
import { ApiError, describeApiError } from "./api.ts";
import type {
  AccountAllocationReview,
  AllocationEvidenceScope,
  AllocationPage,
  AllocationResult,
  BindingFacet,
  EvidenceContribution,
  ExplicitDemand,
  GuildContextEntry,
  ItemStringIdentity,
  UnallocatedInventoryEntry,
  UnresolvedStorageScope,
} from "./types.ts";

// --- cells ---------------------------------------------------------------------------------------------------

/**
 * `bound`: "exact" is the computed value; "atLeast" is a computed floor (more may exist in evidence that is not
 * resolved); "atMost" is a computed ceiling (a shortfall that unseen evidence could reduce).
 */
export type Cell =
  | { kind: "numeric"; value: number; bound: "exact" | "atLeast" | "atMost" }
  | { kind: "withheld"; reason: string }
  | { kind: "notApplicable" };

export const numeric = (value: number, bound: "exact" | "atLeast" | "atMost" = "exact"): Cell => ({ kind: "numeric", value, bound });
export const withheld = (reason: string): Cell => ({ kind: "withheld", reason });
export const NOT_APPLICABLE: Cell = { kind: "notApplicable" };

export const NOT_COMPUTED = "not computed";

/** The text for a cell. A withheld cell names its absence ("not computed"), never a number; not-applicable is a dash. */
export function cellText(cell: Cell): string {
  switch (cell.kind) {
    case "numeric":
      return cell.bound === "atLeast" ? `≥ ${cell.value}` : cell.bound === "atMost" ? `up to ${cell.value}` : String(cell.value);
    case "withheld":
      return cell.reason;
    case "notApplicable":
      return "—";
  }
}

// --- copy ----------------------------------------------------------------------------------------------------

export const NO_TARGET_HEADING = "Held with no target";
export const NO_TARGET_EXPLANATION = "No target set, so surplus is unknown. This is not surplus.";
export const KEEP_EXPLANATION = (n: number | string) =>
  `The account should hold ${n}. Anything confirmed beyond ${n} can become surplus when the evidence is sufficient.`;
export const KEEP_ZERO_EXPLANATION =
  "Keep 0 means you want none of this. Confirmed holdings beyond 0 can become surplus when the evidence is sufficient. This is different from Remove target, which means you have not specified what you want.";
export const REMOVE_TARGET_EXPLANATION =
  'Removing the target means the account no longer has modeled intent for this item. It becomes "no target"; surplus is unknown again.';
export const RECOMMENDATION_ONLY = "Recommendation only. Nothing is moved automatically.";
export const UNPROVEN_VARIANTS_EXPLANATION =
  "These held rows may not be interchangeable because their item strings differ, so they cannot safely be added together against this target.";
export const UNPROVEN_INCOMPLETE_EXPLANATION =
  "Some held rows lack sufficient item-string identity evidence (only the bare item ID was captured), so they cannot safely be added together against this target.";
export const UNKNOWN_QUANTITY_EXPLANATION = "Some stack quantities in observed storage are unknown, so this count is a minimum.";
export const CONFLICT_EXPLANATION =
  "More than one active target exists for this item. No allocation is computed until only one remains; remove the target that no longer applies.";
export const GUILD_NOT_COUNTED = "Guild-owned, not counted";
export const DUPLICATE_TARGET_MESSAGE = "This item already has a target. Edit it instead.";

// --- labels --------------------------------------------------------------------------------------------------

/** The item's display title: the observed name when one is known, else an honest item-ID fallback. */
export function itemTitle(baseItemId: number, name: string | undefined): { title: string; nameKnown: boolean } {
  return name !== undefined && name.trim() !== "" ? { title: name, nameKnown: true } : { title: `Item ${baseItemId}`, nameKnown: false };
}

/** "Name (realm)" from a lowercased `version::realm::name` identity key; the raw key if it is not in that form. */
export function characterLabel(identityKey: string | undefined): string | undefined {
  if (identityKey === undefined) return undefined;
  const parts = identityKey.split("::");
  if (parts.length < 3) return identityKey;
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  return `${cap(parts[parts.length - 1]!)} (${parts.slice(1, -1).map(cap).join(" ")})`;
}

const SCOPE_LABEL: Record<AllocationEvidenceScope, string> = { "character-bags": "bags", "character-bank": "bank", warband: "Warband bank" };

function scopeOwnerLabel(scope: AllocationEvidenceScope, identityKey: string | undefined): string {
  if (scope === "warband") return "Warband bank";
  const who = characterLabel(identityKey);
  return who ? `${who} ${SCOPE_LABEL[scope]}` : `Character ${SCOPE_LABEL[scope]}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- account evidence status -----------------------------------------------------------------------------------

export interface AccountStatusView {
  tone: "clear" | "unresolved";
  message: string;
  /** Rows that could not be attributed to any item (reported, never silently dropped). */
  unidentifiedNote?: string;
}

/** One compact, account-level statement about unseen account-owned storage, from the review's own list. Shown once, not per row. */
export function accountStatusView(review: Pick<AccountAllocationReview, "unresolvedStorage" | "unidentifiedItemRowCount">): AccountStatusView {
  const unidentifiedNote =
    review.unidentifiedItemRowCount > 0
      ? `${plural(review.unidentifiedItemRowCount, "held row", "held rows")} could not be identified as an item and ${review.unidentifiedItemRowCount === 1 ? "is" : "are"} not counted for any item.`
      : undefined;
  if (review.unresolvedStorage.length === 0) {
    return { tone: "clear", message: "Counts are based on observed storage. Every account-owned storage area has been observed at least once.", ...(unidentifiedNote ? { unidentifiedNote } : {}) };
  }
  const count = (scope: AllocationEvidenceScope) => review.unresolvedStorage.filter((s: UnresolvedStorageScope) => s.scope === scope).length;
  const parts: string[] = [];
  const banks = count("character-bank");
  const bags = count("character-bags");
  if (banks > 0) parts.push(plural(banks, "character bank", "character banks"));
  if (bags > 0) parts.push(`${plural(bags, "character's bags", "characters' bags")}`);
  if (count("warband") > 0) parts.push("the Warband bank");
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  const verb = review.unresolvedStorage.length === 1 ? "has" : "have";
  return {
    tone: "unresolved",
    message: `Counts are based on observed storage. ${list.charAt(0).toUpperCase()}${list.slice(1)} ${verb} not been observed, so surplus cannot currently be cleared for sale. Confirmed quantities remain usable.`,
    ...(unidentifiedNote ? { unidentifiedNote } : {}),
  };
}

// --- shared evidence detail ------------------------------------------------------------------------------------

export interface Chip {
  label: string;
  title: string;
}

export interface EvidenceLine {
  label: string;
  text: string;
  tier: "confirmed" | "lastSeen" | "unresolved";
}

export interface DetailView {
  confirmed: EvidenceLine[];
  lastSeen: EvidenceLine[];
  /** Unresolved evidence that applies to THIS item (unknown stack quantities); whole-storage gaps are in the account status. */
  unresolved: EvidenceLine[];
  guild: EvidenceLine[];
  identity?: string;
  binding?: string;
  lastSeenBinding?: string;
  reasons: string[];
}

function quantityText(quantity: number | undefined, unknownRows: number | undefined): string {
  const unknown = unknownRows !== undefined && unknownRows > 0 ? plural(unknownRows, "stack of unknown quantity", "stacks of unknown quantity") : undefined;
  if (quantity === undefined) return unknown ?? "quantity unknown";
  if (unknown) return quantity > 0 ? `${quantity} + ${unknown}` : unknown;
  return String(quantity);
}

const holds = (e: { quantity?: number; unknownQuantityRowCount?: number }) =>
  (e.quantity !== undefined && e.quantity > 0) || (e.unknownQuantityRowCount !== undefined && e.unknownQuantityRowCount > 0);

function bindingText(b: BindingFacet): string | undefined {
  const parts: string[] = [];
  if (b.boundRowCount > 0) parts.push(`${b.boundRowCount} reported bound (soulbound and Warbound are not distinguished)`);
  if (b.unboundRowCount > 0) parts.push(`${b.unboundRowCount} not reported bound (this does not prove it can be traded or moved)`);
  if (b.unknownRowCount > 0) parts.push(`${b.unknownRowCount} binding unknown`);
  return parts.length ? `${parts.join("; ")}.` : undefined;
}

function identityText(identity: ItemStringIdentity): string | undefined {
  switch (identity.class) {
    case "ITEM_STRING_VARIANTS":
      return `Confirmed rows carry ${identity.distinctItemStringCount} different item strings (versions of this item).`;
    case "ITEM_STRING_INCOMPLETE":
      return "At least one confirmed row was captured only as a bare item ID; its other identity fields are unknown.";
    case "UNIFORM_ITEM_STRING":
      return "Confirmed rows share one item string.";
    case "NONE_HELD":
      return undefined;
  }
}

function detailView(
  evidence: readonly EvidenceContribution[],
  guildContext: readonly GuildContextEntry[],
  facets: { confirmedItemStringIdentity: ItemStringIdentity; confirmedBinding: BindingFacet; potentialBinding: BindingFacet },
  reasons: readonly { code: string; detail?: string }[],
): DetailView {
  const line = (e: EvidenceContribution, tier: EvidenceLine["tier"]): EvidenceLine => ({ label: scopeOwnerLabel(e.scope, e.identityKey), text: quantityText(e.quantity, e.unknownQuantityRowCount), tier });
  const binding = bindingText(facets.confirmedBinding);
  const lastSeenBinding = bindingText(facets.potentialBinding);
  const identity = identityText(facets.confirmedItemStringIdentity);
  return {
    confirmed: evidence.filter((e) => e.admissibility === "CONFIRMED" && holds(e)).map((e) => line(e, "confirmed")),
    lastSeen: evidence.filter((e) => e.admissibility === "POTENTIAL" && holds(e)).map((e) => line(e, "lastSeen")),
    unresolved: evidence
      .filter((e) => e.admissibility === "UNRESOLVED" && e.unresolvedCause === "ITEM_QUANTITY_UNKNOWN")
      .map((e) => ({ label: scopeOwnerLabel(e.scope, e.identityKey), text: "observed, but some stack quantities were not reported", tier: "unresolved" as const })),
    guild: guildContext.filter(holds).map((g) => ({ label: "Guild bank", text: `${quantityText(g.quantity, g.unknownQuantityRowCount)} · ${GUILD_NOT_COUNTED}`, tier: g.admissibility === "POTENTIAL" ? ("lastSeen" as const) : ("confirmed" as const) })),
    ...(identity ? { identity } : {}),
    ...(binding ? { binding } : {}),
    ...(lastSeenBinding ? { lastSeenBinding: `Last seen (historical, never gates anything): ${lastSeenBinding}` } : {}),
    reasons: reasons.filter((r) => r.detail !== undefined).map((r) => r.detail!),
  };
}

/** "+8 last seen (historical)" — separate from, and never added to, the confirmed count. Undefined when there is no LAST_SEEN evidence. */
export function lastSeenText(potentialQuantity: number, potentialUnknownRows: number): string | undefined {
  if (potentialQuantity > 0 && potentialUnknownRows > 0) return `+${potentialQuantity} or more last seen (historical; some quantities unknown)`;
  if (potentialQuantity > 0) return `+${potentialQuantity} last seen (historical)`;
  if (potentialUnknownRows > 0) return "Also last seen in historical storage (quantity unknown)";
  return undefined;
}

const potentialUnknownRows = (evidence: readonly EvidenceContribution[]) =>
  evidence.filter((e) => e.admissibility === "POTENTIAL").reduce((total, e) => total + (e.unknownQuantityRowCount !== undefined ? e.unknownQuantityRowCount : 0), 0);

// --- your targets ----------------------------------------------------------------------------------------------

export type TargetState = "short" | "onTarget" | "surplusEligible" | "surplusReview" | "unproven" | "conflict" | "noTarget";

export interface ConflictRecord {
  stableId: string;
  /** Undefined when the record is not among the loaded demands (it is never guessed). */
  requiredQuantity?: number;
  purpose?: string;
}

export interface TargetRowView {
  baseItemId: number;
  title: string;
  nameKnown: boolean;
  state: TargetState;
  /** The editable demand (RESOLVED / UNPROVEN). Absent for a conflict, which has no single demand. */
  demand?: { stableId: string; requiredQuantity: number; purpose?: string };
  keep: Cell;
  have: Cell;
  allocated: Cell;
  short: Cell;
  surplus: Cell;
  /** The one-line primary state, readable without expanding the row. */
  summary: string;
  status: { label: string; tone: "short" | "ok" | "eligible" | "review" };
  /** Short sentences shown under the summary (uncertainty wording, recommendation-only, UNPROVEN explanation). */
  notes: string[];
  chips: Chip[];
  lastSeen?: string;
  conflict?: ConflictRecord[];
  detail: DetailView;
}

const hasReason = (result: AllocationResult, code: string) => result.reasons.some((r) => r.code === code);

function rowChips(result: AllocationResult, include: { storage: boolean }): Chip[] {
  const chips: Chip[] = [];
  if (include.storage && hasReason(result, "UNRESOLVED_STORAGE_PRESENT")) chips.push({ label: "Unseen storage", title: "Some account-owned storage has not been observed; it could hold more of this item." });
  if (hasReason(result, "ITEM_QUANTITY_UNKNOWN_PRESENT")) chips.push({ label: "Unknown quantity", title: UNKNOWN_QUANTITY_EXPLANATION });
  if (hasReason(result, "BOUND_INVENTORY_PRESENT")) chips.push({ label: "Bound", title: "Some confirmed rows are reported bound by the game client; those units may be restricted." });
  if (hasReason(result, "BINDING_UNKNOWN_PRESENT")) chips.push({ label: "Binding unknown", title: "Some confirmed rows have no captured binding state." });
  return chips;
}

/**
 * The view of one demanded result. Each variant is presented from the fields IT carries; nothing absent is
 * substituted. `demands` (any status) resolves a conflict's demand ids to their quantities/purposes for display.
 */
export function targetRowView(result: AllocationResult, name: string | undefined, demands: readonly ExplicitDemand[] = []): TargetRowView {
  const { title, nameKnown } = itemTitle(result.commodity.baseItemId, name);
  const base = { baseItemId: result.commodity.baseItemId, title, nameKnown };

  if (result.resolution === "CONFLICTING_DEMAND") {
    const conflict = result.conflictingDemandIds.map((stableId): ConflictRecord => {
      const record = demands.find((d) => d.stableId === stableId);
      return record ? { stableId, requiredQuantity: record.requiredQuantity, ...(record.purpose ? { purpose: record.purpose } : {}) } : { stableId };
    });
    const reason = "conflicting targets";
    return {
      ...base,
      state: "conflict",
      keep: withheld(reason),
      have: withheld(reason),
      allocated: withheld(NOT_COMPUTED),
      short: withheld(NOT_COMPUTED),
      surplus: withheld(NOT_COMPUTED),
      summary: `${plural(conflict.length, "active target", "active targets")} for this item · Allocation: ${NOT_COMPUTED}`,
      status: { label: "Needs review", tone: "review" },
      notes: [CONFLICT_EXPLANATION],
      chips: [{ label: "Conflicting targets", title: CONFLICT_EXPLANATION }],
      conflict,
      detail: detailView(result.evidence, result.guildContext, result, result.reasons),
    };
  }

  if (result.resolution === "NO_ACTIVE_DEMAND") {
    // Not expected in the demanded list (the review only demands items with an active target); presented honestly if it ever is.
    return {
      ...base,
      state: "noTarget",
      keep: NOT_APPLICABLE,
      have: NOT_APPLICABLE,
      allocated: NOT_APPLICABLE,
      short: NOT_APPLICABLE,
      surplus: NOT_APPLICABLE,
      summary: "No active target · surplus is unknown",
      status: { label: "No target", tone: "review" },
      notes: [NO_TARGET_EXPLANATION],
      chips: [],
      detail: detailView(result.evidence, result.guildContext, result, result.reasons),
    };
  }

  const demand = { stableId: result.demand.stableId, requiredQuantity: result.demand.requiredQuantity, ...(result.demand.purpose ? { purpose: result.demand.purpose } : {}) };
  const keep = numeric(result.demand.requiredQuantity);
  const quantityUnknown = hasReason(result, "ITEM_QUANTITY_UNKNOWN_PRESENT");
  const storageUnknown = hasReason(result, "UNRESOLVED_STORAGE_PRESENT");
  const detail = detailView(result.evidence, result.guildContext, result, result.reasons);

  if (result.resolution === "BASE_ITEM_AGGREGATION_UNPROVEN") {
    const identity = result.confirmedItemStringIdentity;
    const versions = identity.class === "ITEM_STRING_VARIANTS" ? `${identity.distinctItemStringCount} different versions of this item` : "Incomplete item identity";
    const seen = numeric(result.confirmedQuantity, quantityUnknown ? "atLeast" : "exact");
    const lastSeen = lastSeenText(result.potentialQuantity, potentialUnknownRows(result.evidence));
    return {
      ...base,
      state: "unproven",
      demand,
      keep,
      have: seen,
      allocated: withheld(NOT_COMPUTED),
      short: withheld(NOT_COMPUTED),
      surplus: withheld(NOT_COMPUTED),
      summary: `Keep ${result.demand.requiredQuantity} · Seen ${cellText(seen)} · ${versions} · Allocation: ${NOT_COMPUTED}`,
      status: { label: "Needs review", tone: "review" },
      notes: [identity.class === "ITEM_STRING_VARIANTS" ? UNPROVEN_VARIANTS_EXPLANATION : UNPROVEN_INCOMPLETE_EXPLANATION, ...(quantityUnknown ? [UNKNOWN_QUANTITY_EXPLANATION] : [])],
      chips: [{ label: versions, title: identity.class === "ITEM_STRING_VARIANTS" ? UNPROVEN_VARIANTS_EXPLANATION : UNPROVEN_INCOMPLETE_EXPLANATION }, ...rowChips(result, { storage: false })],
      ...(lastSeen ? { lastSeen } : {}),
      detail,
    };
  }

  // RESOLVED: the server computed allocated / confirmedDeficit / confirmedSurplus; present exactly those.
  const uncertain = result.hasUnresolvedEvidence;
  const have = numeric(result.confirmedAvailable, quantityUnknown ? "atLeast" : "exact");
  const lastSeen = lastSeenText(result.potentialAdditionalAvailable, potentialUnknownRows(result.evidence));
  const common = { ...base, demand, keep, have, allocated: numeric(result.allocated), ...(lastSeen ? { lastSeen } : {}), detail };
  const prefix = `Keep ${result.demand.requiredQuantity} · Have ${cellText(have)}`;

  if (result.confirmedDeficit > 0) {
    const short = numeric(result.confirmedDeficit, uncertain ? "atMost" : "exact");
    const notes: string[] = [];
    if (uncertain) {
      const why = storageUnknown && quantityUnknown ? "unseen storage or unknown stack quantities could hold more" : storageUnknown ? "unseen storage could hold more" : "some stack quantities are unknown and could be more";
      notes.push(`Up to ${result.confirmedDeficit} short; ${why}.`);
    }
    return {
      ...common,
      state: "short",
      short,
      surplus: NOT_APPLICABLE,
      summary: `${prefix} · ${uncertain ? `Up to ${result.confirmedDeficit} short` : `Short ${result.confirmedDeficit}`}`,
      status: { label: "Short", tone: "short" },
      notes,
      chips: rowChips(result, { storage: true }),
    };
  }

  if (result.confirmedSurplus === 0) {
    return {
      ...common,
      state: "onTarget",
      short: numeric(0),
      surplus: numeric(0, uncertain ? "atLeast" : "exact"),
      summary: `${prefix} · On target`,
      status: { label: "On target", tone: "ok" },
      notes: [],
      chips: rowChips(result, { storage: false }),
    };
  }

  const surplus = numeric(result.confirmedSurplus, uncertain ? "atLeast" : "exact");
  if (result.disposition === "SEND_HELLOMAGS") {
    return {
      ...common,
      state: "surplusEligible",
      short: numeric(0),
      surplus,
      summary: `${prefix} · ${result.confirmedSurplus} surplus`,
      status: { label: "Eligible for Hellomags", tone: "eligible" },
      notes: [RECOMMENDATION_ONLY],
      chips: rowChips(result, { storage: false }),
    };
  }
  // A confirmed surplus whose sale disposition is gated (unresolved evidence and/or binding).
  const notes: string[] = [];
  if (hasReason(result, "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE")) notes.push(storageUnknown ? "Unseen storage could hold more, so this surplus is a minimum and is not cleared for sale yet." : "Some stack quantities are unknown, so this surplus is a minimum and is not cleared for sale yet.");
  if (hasReason(result, "SALE_DISPOSITION_GATED_BY_BINDING")) notes.push("Some confirmed rows are bound or have unknown binding, so this surplus is not recommended for sale.");
  notes.push(RECOMMENDATION_ONLY);
  return {
    ...common,
    state: "surplusReview",
    short: numeric(0),
    surplus,
    summary: `${prefix} · ${uncertain ? `At least ${result.confirmedSurplus} surplus` : `${result.confirmedSurplus} surplus`} · Needs review`,
    status: { label: "Needs review", tone: "review" },
    notes,
    chips: rowChips(result, { storage: true }),
  };
}

export function targetRowViews(review: Pick<AccountAllocationReview, "demanded" | "itemNames">, demands: readonly ExplicitDemand[] = []): TargetRowView[] {
  return review.demanded.items.map((result) => targetRowView(result, review.itemNames[String(result.commodity.baseItemId)], demands));
}

// --- held with no target ---------------------------------------------------------------------------------------

/** A no-target row. By construction it has NO surplus, deficit, allocation, or disposition field. */
export interface NoTargetRowView {
  baseItemId: number;
  title: string;
  nameKnown: boolean;
  seen: Cell;
  lastSeen?: string;
  chips: Chip[];
  detail: DetailView;
}

export function noTargetRowView(entry: UnallocatedInventoryEntry): NoTargetRowView {
  const { title, nameKnown } = itemTitle(entry.baseItemId, entry.name);
  const quantityUnknown = entry.holdings.some((h) => h.admissibility === "UNRESOLVED" && h.unresolvedCause === "ITEM_QUANTITY_UNKNOWN");
  const chips: Chip[] = [];
  if (quantityUnknown) chips.push({ label: "Unknown quantity", title: UNKNOWN_QUANTITY_EXPLANATION });
  if (entry.confirmedItemStringIdentity.class === "ITEM_STRING_VARIANTS") chips.push({ label: `${entry.confirmedItemStringIdentity.distinctItemStringCount} versions`, title: "Confirmed rows carry different item strings." });
  if (entry.confirmedItemStringIdentity.class === "ITEM_STRING_INCOMPLETE") chips.push({ label: "Incomplete identity", title: "Some confirmed rows were captured only as a bare item ID." });
  if (entry.confirmedBinding.boundRowCount > 0) chips.push({ label: "Bound", title: "Some confirmed rows are reported bound by the game client." });
  if (entry.confirmedBinding.unknownRowCount > 0) chips.push({ label: "Binding unknown", title: "Some confirmed rows have no captured binding state." });
  const lastSeen = lastSeenText(entry.potentialQuantity, entry.potentialUnknownQuantityRowCount);
  return {
    baseItemId: entry.baseItemId,
    title,
    nameKnown,
    seen: numeric(entry.confirmedQuantity, quantityUnknown ? "atLeast" : "exact"),
    ...(lastSeen ? { lastSeen } : {}),
    chips,
    detail: detailView(entry.holdings, entry.guildContext, entry, []),
  };
}

// --- removed (inactive) targets ----------------------------------------------------------------------------------

export interface RemovedTargetView {
  stableId: string;
  baseItemId: number;
  title: string;
  requiredQuantity: number;
  purpose?: string;
  removedAt: number;
  /** When the item already has an ACTIVE target again, the action is to edit that one, never to create a second. */
  hasActiveTarget: boolean;
}

/** INACTIVE demands, newest first: read-only history. `names` is whatever the page already knows; unknown names fall back to the item ID. */
export function removedTargetViews(demands: readonly ExplicitDemand[], names: Readonly<Record<string, string>>): RemovedTargetView[] {
  const active = new Set(demands.filter((d) => d.status === "ACTIVE").map((d) => d.commodity.baseItemId));
  return demands
    .filter((d) => d.status === "INACTIVE")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({
      stableId: d.stableId,
      baseItemId: d.commodity.baseItemId,
      title: itemTitle(d.commodity.baseItemId, names[String(d.commodity.baseItemId)]).title,
      requiredQuantity: d.requiredQuantity,
      ...(d.purpose ? { purpose: d.purpose } : {}),
      removedAt: d.updatedAt,
      hasActiveTarget: active.has(d.commodity.baseItemId),
    }));
}

/** Names the page already knows (the demanded sidecar plus the unallocated page's observed names). */
export function knownNames(review: Pick<AccountAllocationReview, "itemNames" | "unallocated">): Record<string, string> {
  const names: Record<string, string> = { ...review.itemNames };
  for (const entry of review.unallocated.items) if (entry.name !== undefined) names[String(entry.baseItemId)] = entry.name;
  return names;
}

// --- paging --------------------------------------------------------------------------------------------------

export interface PageView {
  text: string;
  prevOffset?: number;
  nextOffset?: number;
}

export function pageView(page: Pick<AllocationPage<unknown>, "items" | "offset" | "limit" | "totalCount">): PageView {
  if (page.totalCount === 0 || page.items.length === 0) return { text: `0 of ${page.totalCount}` };
  const first = page.offset + 1;
  const last = page.offset + page.items.length;
  return {
    text: `${first}–${last} of ${page.totalCount}`,
    ...(page.offset > 0 ? { prevOffset: Math.max(page.offset - page.limit, 0) } : {}),
    ...(last < page.totalCount ? { nextOffset: last } : {}),
  };
}

// --- form input + mutation errors --------------------------------------------------------------------------------

/** "Keep N": a whole number >= 0 (0 is valid and meaningful). Returns the number or a message; never coerces. */
export function parseKeepQuantity(text: string): { value: number } | { error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { error: "Enter a whole number of 0 or more." };
  const value = Number(t);
  return Number.isSafeInteger(value) ? { value } : { error: "That number is too large." };
}

export function parseItemId(text: string): { value: number } | { error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t) || Number(t) <= 0 || !Number.isSafeInteger(Number(t))) return { error: "Enter an item ID (a positive whole number)." };
  return { value: Number(t) };
}

/** The help text under the Keep field for the quantity currently typed. */
export function keepHelp(text: string): string {
  const parsed = parseKeepQuantity(text);
  if ("error" in parsed) return KEEP_EXPLANATION("N");
  return parsed.value === 0 ? KEEP_ZERO_EXPLANATION : KEEP_EXPLANATION(parsed.value);
}

export interface DemandErrorView {
  message: string;
  /** Set for a duplicate target: the existing ACTIVE demand to bring into view and edit instead. */
  existingStableId?: string;
  /** The page should re-read state (the target changed or vanished underneath). */
  refresh: boolean;
}

export function describeDemandError(err: unknown): DemandErrorView {
  if (err instanceof ApiError && err.kind === "http") {
    if (err.status === 409 && err.code === "DEMAND_CONFLICT") {
      const details = err.details as { existingStableId?: unknown } | undefined;
      const existing = details && typeof details.existingStableId === "string" ? details.existingStableId : undefined;
      return { message: DUPLICATE_TARGET_MESSAGE, ...(existing ? { existingStableId: existing } : {}), refresh: true };
    }
    if (err.status === 409 && err.code === "DEMAND_INACTIVE") return { message: "This target was already removed, so it can't be changed. Set a new target instead.", refresh: true };
    if (err.status === 404 && err.code === "DEMAND_NOT_FOUND") return { message: "This target no longer exists.", refresh: true };
  }
  return { message: describeApiError(err), refresh: false };
}
