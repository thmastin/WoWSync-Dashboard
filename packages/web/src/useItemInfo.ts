import { createContext, useContext, useMemo } from "react";
import { fetchItemMetadata } from "./api.ts";
import { EMPTY_ITEM_INFO, buildItemInfoLookup, type ItemInfoLookup } from "./itemMetadata.ts";
import { useAsync } from "./useAsync.ts";

/**
 * Item metadata for the Shared Storage view's deep component chain (owner card -> observation -> item table).
 * Defaults to "nothing known", so anything rendered without a provider behaves exactly as before metadata existed.
 * Character pages pass the same lookup as a plain prop instead.
 */
export const ItemInfoContext = createContext<ItemInfoLookup>(EMPTY_ITEM_INFO);

export function useItemInfo(): ItemInfoLookup {
  return useContext(ItemInfoContext);
}

/**
 * Loads one game version's item metadata. Metadata is enrichment: a failed request (server out of date, offline)
 * is not an error state - the page simply has no item info and every list renders as before. `version`
 * undefined (the character is not loaded yet) loads nothing.
 */
export function useItemInfoLoader(version: string | undefined, refreshTick = 0): ItemInfoLookup {
  const load = useAsync(
    async (signal) => {
      if (version === undefined) return undefined;
      try {
        return (await fetchItemMetadata(version, signal)).items;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err; // superseded on purpose
        return undefined;
      }
    },
    `item-metadata:${version ?? "none"}`,
    refreshTick,
  );
  const items = load.state.data;
  return useMemo(() => buildItemInfoLookup(items), [items]);
}
