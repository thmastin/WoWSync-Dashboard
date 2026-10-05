// Section builders for Azeroth ERP allocation tests (Dashboard Allocation tab milestone): character bags/bank,
// Warband and Guild sections rendered through the real export text (sharedStorageExports.ts) and importer.
// Shared by core and server tests. Not a test file (the test glob is *.test.ts).
import type { AccountBankSection, GuildBankSection, InventoryItemRecord, InventorySection } from "../src/types.ts";

export const T = 1_790_000_000;

/** A full item string for one base item; `variant` changes a bonus-id field so two variants are distinct item strings. */
export const fullRef = (id: number, variant?: number) => (variant === undefined ? `item:${id}::::::::80` : `item:${id}::::::::80:::::1:${variant}`);

/** One held row. `name: undefined` renders as `?` (an unobserved name). */
export function row(id: number, qty: number | undefined, opts: { name?: string | null; bound?: string; ref?: string } = {}): InventoryItemRecord {
  const name = opts.name === null ? undefined : (opts.name ?? `Allocation fixture ${id}`);
  return { itemRef: opts.ref ?? fullRef(id), ...(name !== undefined ? { name } : {}), qty, bound: opts.bound ?? "no", vendorEachCopper: 100 };
}

export function observedSection(items: InventoryItemRecord[], observedAt = T): InventorySection {
  return {
    status: { state: "OBSERVED", completeness: "complete", observedAt },
    containers: [{ id: 0, capacity: 40, free: 40 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 40 - items.length,
    totalSlots: 40,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

export function warbandSection(state: "OBSERVED" | "LAST_SEEN", items: InventoryItemRecord[], observedAt = T): AccountBankSection {
  return {
    status: { state, completeness: "complete", observedAt },
    ownerScope: "ACCOUNT_WARBAND",
    coverage: "ACCOUNT/Warband purchased tabs only",
    snapshotVisit: observedAt - 1,
    purchasedBankTabs: 1,
    containers: [{ id: 12, storage: "ACCOUNT_WARBAND", capacity: 98, free: 98 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 98 - items.length,
    totalSlots: 98,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

export function guildSection(clubId: string, items: InventoryItemRecord[], observedAt = T): GuildBankSection {
  return {
    status: { state: "OBSERVED", completeness: "complete", observedAt },
    ownerScope: "GUILD",
    guildClubId: clubId,
    guildName: "Allocation Fixture Guild",
    coverage: "All tabs currently reported viewable were serialized through QueryGuildBankTab; inaccessible tabs were not scanned.",
    snapshotVisit: observedAt - 5,
    tabs: [{ id: 1, name: "Tab 1", viewable: true, state: "OBSERVED" }],
    containers: [{ id: 1, storage: "GUILD", capacity: 98, free: 98 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 98 - items.length,
    totalSlots: 98,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}
