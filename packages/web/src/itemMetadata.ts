// Presentation of item metadata (game-client enrichment; see @wowsync-dashboard/core itemMetadata.ts).
//
// Pure functions only. The server already resolved every facet (KNOWN / UNKNOWN / CONFLICT) and derived the
// expansion label, so this module never derives a label itself: it only chooses words. One lookup serves every
// item list (bags, Character Bank, Warband, Guild Bank) - there is no store-specific metadata handling.
//
// Unknown stays unknown: no metadata for an item is "?", never an empty string, "No" or a guessed label.
import { itemIdFromItemRef, type FacetState, type ItemMetadataView } from "@wowsync-dashboard/core/itemMetadata.ts";

/** Item metadata for one game version, keyed by base item id. Empty when nothing has been exported (or the request failed). */
export interface ItemInfoLookup {
  /** True when at least one item has any metadata. When false, no UI should imply that metadata exists. */
  readonly available: boolean;
  /** The metadata for the item an `itemRef` names, or undefined when the export never reported one (every facet UNKNOWN). */
  forItemRef(itemRef: string | undefined): ItemMetadataView | undefined;
}

export const EMPTY_ITEM_INFO: ItemInfoLookup = { available: false, forItemRef: () => undefined };

export function buildItemInfoLookup(items: readonly ItemMetadataView[] | undefined): ItemInfoLookup {
  if (!items || items.length === 0) return EMPTY_ITEM_INFO;
  const byId = new Map<number, ItemMetadataView>(items.map((view) => [view.baseItemId, view]));
  return {
    available: true,
    forItemRef(itemRef) {
      const id = itemIdFromItemRef(itemRef);
      return id === undefined ? undefined : byId.get(id);
    },
  };
}

export type ReagentState = "yes" | "no" | "unknown" | "conflict";

export interface ItemInfoDisplay {
  /** The expansion in words: a supported label, or "Expansion unknown (client value N)" / "Expansion unknown". Never a guess. */
  expansionText: string;
  /** True only when the Dashboard has a supported label for the client's value. */
  expansionKnown: boolean;
  reagent: ReagentState;
  /** Compact cell text: "Midnight · Reagent", "Dragonflight", "?" (nothing known). Unknown parts are omitted, never zeroed. */
  cell: string;
  /** A full, screen-reader-friendly sentence: every part stated, including what is unknown. */
  summary: string;
}

function reagentState(facet: FacetState<boolean>): ReagentState {
  if (facet.state === "UNKNOWN") return "unknown";
  if (facet.state === "CONFLICT") return "conflict";
  return facet.value ? "yes" : "no";
}

const REAGENT_SUMMARY: Record<ReagentState, string> = {
  yes: "Crafting reagent",
  no: "Not a crafting reagent",
  unknown: "Crafting reagent status unknown",
  conflict: "Crafting reagent status unknown (conflicting client reports)",
};

/**
 * Words for one item's metadata. `view` undefined = the export never reported this item: every facet unknown.
 * The compact cell says only what is known; the summary spells out everything, including the unknowns.
 */
export function describeItemInfo(view: ItemMetadataView | undefined): ItemInfoDisplay {
  if (!view) {
    return {
      expansionText: "Expansion unknown",
      expansionKnown: false,
      reagent: "unknown",
      cell: "?",
      summary: `Expansion unknown. ${REAGENT_SUMMARY.unknown}.`,
    };
  }
  const reagent = reagentState(view.craftingReagent);
  const expansionKnown = view.expansion.state === "KNOWN";
  // Unknown expansion alone reads as "?"; an unmapped or conflicting value keeps its explanatory text so the raw number is not lost.
  const expansionPart =
    view.expansion.state === "UNKNOWN" ? undefined : view.expansion.text;
  const reagentPart = reagent === "yes" ? "Reagent" : reagent === "no" ? "Not a reagent" : undefined;
  const parts = [expansionPart, reagentPart].filter((p): p is string => p !== undefined);
  return {
    expansionText: view.expansion.text,
    expansionKnown,
    reagent,
    cell: parts.length > 0 ? parts.join(" · ") : "?",
    summary: `${view.expansion.text}. ${REAGENT_SUMMARY[reagent]}.`,
  };
}

/**
 * The short suffix for compact item lists (" — Midnight · Reagent"), or "" when there is nothing to add, so a list gains no
 * "?" noise. It is deliberately terser than the table cell: an unsupported client value is "Expansion unknown (0)" and only a
 * positive "Reagent" is stated. The full wording (including "Not a reagent" and every unknown) is the item's tooltip
 * (`describeItemInfo(view).summary`) and the Shared Storage table.
 */
export function itemInfoSuffix(view: ItemMetadataView | undefined): string {
  if (!view) return "";
  const expansion =
    view.expansion.state === "UNKNOWN" ? undefined : view.expansion.state === "UNMAPPED" ? `Expansion unknown (${view.expansion.rawValue})` : view.expansion.text;
  const reagent = describeItemInfo(view).reagent === "yes" ? "Reagent" : undefined;
  return [expansion, reagent].filter((p): p is string => p !== undefined).join(" · ");
}

/** Shown once under a table that has an item-info column. */
export const ITEM_INFO_NOTE =
  "Item info is what the game client reported for each item (as exported by the addon). The expansion is the client's own tag for the item, which is not always the expansion the item was introduced in. “?” means the client did not report it; nothing is guessed from an item's name or number.";
