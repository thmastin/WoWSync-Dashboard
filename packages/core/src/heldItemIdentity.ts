// Azeroth ERP Vertical Slice 3 — held-item identity and binding facts (pure).
//
// Two independent questions about the account-owned rows of one base item, answered per evidence tier:
//
//   1. Can these rows safely be aggregated by base item id? Two rows of one base item can still be different
//      held items (different enchant, gems, suffix, bonus IDs, modifiers, context, ...). The captured item
//      string is the only evidence of that. This module never proves two rows are the SAME unit; it only
//      establishes whether base-item aggregation is NOT PROVEN valid. It is deliberately not called "exact"
//      or "instance" identity.
//
//   2. What did the client say about binding? `bound` is the renderer's mapping of
//      C_Container.GetContainerItemInfo(...).isBound: "yes" (currently bound — any form, including
//      account/Warbound; soulbound and Warbound are not distinguished), "no" (not currently bound — this does
//      NOT certify auctionability, mailability, or sale-pipeline eligibility), or missing/`?` (UNKNOWN).
//
// Nothing here is persisted and nothing here invents positive transferability.

/**
 * Field positions (0-based, counted after the `item:` prefix) that describe the VIEWING character rather than
 * the held item: linkLevel and specID. Every other represented field is preserved exactly.
 */
const VIEWER_FIELD_INDEXES: readonly number[] = [8, 9];

/**
 * One captured item string, classified:
 *   FULL - the client's full item string; `normalized` is it with linkLevel/specID blanked and trailing empty
 *          fields stripped. Nothing else is reordered or rewritten ("" and "0" stay distinct; bonus IDs keep
 *          their order; no modifier/bonus/context value is treated as harmless).
 *   BARE - the `item:<itemID>` fallback used when no hyperlink was available. The remaining identity fields are
 *          UNKNOWN, not empty.
 * `undefined` for anything that is not an item string with a base item id (such rows are already counted as
 * unidentified and are never attributed to an item).
 */
export type ParsedItemString = { readonly kind: "FULL"; readonly normalized: string } | { readonly kind: "BARE" };

export function parseItemString(itemRef: string | undefined): ParsedItemString | undefined {
  if (!itemRef) return undefined;
  const match = /^item:(\d+)(:.*)?$/s.exec(itemRef);
  if (!match) return undefined;
  if (match[2] === undefined) return { kind: "BARE" };
  const fields = itemRef.slice("item:".length).split(":");
  for (const index of VIEWER_FIELD_INDEXES) if (index < fields.length) fields[index] = "";
  while (fields.length > 1 && fields[fields.length - 1] === "") fields.pop();
  return { kind: "FULL", normalized: `item:${fields.join(":")}` };
}

/**
 * Whether one evidence tier's rows of a base item can be aggregated by base item id:
 *   UNIFORM_ITEM_STRING    - every row has a full item string and all normalize identically.
 *   ITEM_STRING_VARIANTS   - two or more distinct normalized full strings (takes precedence over incomplete rows).
 *   ITEM_STRING_INCOMPLETE - at least one bare `item:<id>` row and no full-string variants.
 *   NONE_HELD              - no rows of this item in the tier.
 */
export type ItemStringIdentityClass = "UNIFORM_ITEM_STRING" | "ITEM_STRING_VARIANTS" | "ITEM_STRING_INCOMPLETE" | "NONE_HELD";
export const ITEM_STRING_IDENTITY_CLASSES: readonly ItemStringIdentityClass[] = ["UNIFORM_ITEM_STRING", "ITEM_STRING_VARIANTS", "ITEM_STRING_INCOMPLETE", "NONE_HELD"];

export interface ItemStringIdentity {
  readonly class: ItemStringIdentityClass;
  /** Distinct normalized FULL item strings in the tier. Bare rows are never counted as a distinct string: their identity is unknown. */
  readonly distinctItemStringCount: number;
}

/** Binding ROW counts (not item quantities) for one evidence tier. */
export interface BindingFacet {
  readonly boundRowCount: number;
  readonly unboundRowCount: number;
  readonly unknownRowCount: number;
}

/** "yes" and "no" are the only known values; anything else (missing, `?`, or unexpected) is UNKNOWN. */
export function bindingState(bound: string | undefined): "BOUND" | "UNBOUND" | "UNKNOWN" {
  if (bound === "yes") return "BOUND";
  if (bound === "no") return "UNBOUND";
  return "UNKNOWN";
}

/** Mutable per-scope accumulator of the row facts behind both facets. */
export interface HeldRowFacts {
  readonly normalizedItemStrings: Set<string>;
  incompleteRowCount: number;
  boundRowCount: number;
  unboundRowCount: number;
  unknownBindingRowCount: number;
}

export function emptyHeldRowFacts(): HeldRowFacts {
  return { normalizedItemStrings: new Set(), incompleteRowCount: 0, boundRowCount: 0, unboundRowCount: 0, unknownBindingRowCount: 0 };
}

export function recordHeldRow(facts: HeldRowFacts, parsed: ParsedItemString, bound: string | undefined): void {
  if (parsed.kind === "FULL") facts.normalizedItemStrings.add(parsed.normalized);
  else facts.incompleteRowCount++;
  const state = bindingState(bound);
  if (state === "BOUND") facts.boundRowCount++;
  else if (state === "UNBOUND") facts.unboundRowCount++;
  else facts.unknownBindingRowCount++;
}

/** Classifies the union of several scopes' row facts (one evidence tier). */
export function classifyItemStringIdentity(tier: readonly Pick<HeldRowFacts, "normalizedItemStrings" | "incompleteRowCount">[]): ItemStringIdentity {
  const strings = new Set<string>();
  let incomplete = 0;
  for (const facts of tier) {
    for (const value of facts.normalizedItemStrings) strings.add(value);
    incomplete += facts.incompleteRowCount;
  }
  const distinctItemStringCount = strings.size;
  if (distinctItemStringCount >= 2) return { class: "ITEM_STRING_VARIANTS", distinctItemStringCount };
  if (incomplete > 0) return { class: "ITEM_STRING_INCOMPLETE", distinctItemStringCount };
  if (distinctItemStringCount === 1) return { class: "UNIFORM_ITEM_STRING", distinctItemStringCount };
  return { class: "NONE_HELD", distinctItemStringCount: 0 };
}

export function sumBinding(tier: readonly Pick<HeldRowFacts, "boundRowCount" | "unboundRowCount" | "unknownBindingRowCount">[]): BindingFacet {
  return tier.reduce<BindingFacet>(
    (total, facts) => ({
      boundRowCount: total.boundRowCount + facts.boundRowCount,
      unboundRowCount: total.unboundRowCount + facts.unboundRowCount,
      unknownRowCount: total.unknownRowCount + facts.unknownBindingRowCount,
    }),
    { boundRowCount: 0, unboundRowCount: 0, unknownRowCount: 0 },
  );
}

/** Confirmed arithmetic over base-item aggregation is allowed only for these CONFIRMED classes. */
export function allowsBaseItemAggregation(identity: ItemStringIdentity): boolean {
  return identity.class === "UNIFORM_ITEM_STRING" || identity.class === "NONE_HELD";
}

/**
 * The four held-row facets for one base item: CONFIRMED (OBSERVED) and POTENTIAL (LAST_SEEN) tiers kept
 * independent. Account-owned scopes only; guild rows never contribute. Potential facets are reported and
 * never gate confirmed arithmetic or disposition.
 */
export interface HeldItemFacets {
  readonly confirmedItemStringIdentity: ItemStringIdentity;
  readonly potentialItemStringIdentity: ItemStringIdentity;
  readonly confirmedBinding: BindingFacet;
  readonly potentialBinding: BindingFacet;
}
