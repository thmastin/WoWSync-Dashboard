// Builders for shared-storage tests: synthetic Warband / Guild sections shaped the way the
// addon renders them (containers only for OBSERVED guild tabs, items aggregated across tabs),
// plus carrier and journal helpers. Not a test file (the test glob is *.test.ts).
import assert from "node:assert/strict";
import { EMPTY_JOURNAL, addToJournal, admitSection, type CarrierExport, type CarrierState, type SharedJournal } from "../src/sharedStorage.ts";
import type { AccountBankSection, GuildBankSection, GuildBankTab, SectionStatus } from "../src/types.ts";

export const BIG_ID = "18014398509481985"; // above 2^53

export type TabSpec = { id: number; name: string; state?: "OBSERVED" | "INACCESSIBLE" | "UNKNOWN"; items?: Array<[string, number]> };

export function itemRow(name: string, qty: number) {
  return { itemRef: `item:${name.length}${name.charCodeAt(0)}::`, name, qty, bound: "no", vendorEachCopper: 10 };
}

function aggregate(pairs: Array<[string, number]>) {
  const totals = new Map<string, number>();
  for (const [name, qty] of pairs) totals.set(name, (totals.get(name) ?? 0) + qty);
  return [...totals.entries()].map(([name, qty]) => itemRow(name, qty));
}

export interface GuildSpec {
  clubId?: string | null;
  name?: string;
  observedAt: number;
  state?: CarrierState;
  completeness?: string;
  tabs: TabSpec[];
  snapshotVisit?: number;
  status?: Partial<SectionStatus>;
}

/** A guild section the way the addon renders one: containers only for OBSERVED tabs, items aggregated across tabs. */
export function guild(spec: GuildSpec): GuildBankSection {
  const tabs: GuildBankTab[] = spec.tabs.map((t) => ({
    id: t.id,
    name: t.name,
    viewable: (t.state ?? "OBSERVED") !== "INACCESSIBLE",
    state: t.state ?? "OBSERVED",
    note: t.state === "UNKNOWN" ? "Guild Bank query response timed out" : undefined,
  }));
  const observed = spec.tabs.filter((t) => (t.state ?? "OBSERVED") === "OBSERVED");
  const items = aggregate(observed.flatMap((t) => t.items ?? []));
  const containers = observed.map((t) => ({ id: t.id, storage: "GUILD", capacity: 98, free: 98 - (t.items ?? []).length, family: "0", bagRef: "-" }));
  const allObserved = !spec.tabs.some((t) => t.state === "UNKNOWN");
  const viewable = spec.tabs.filter((t) => t.state !== "INACCESSIBLE").length;
  return {
    status: { state: spec.state ?? "OBSERVED", completeness: spec.completeness ?? "complete", observedAt: spec.observedAt, ...spec.status },
    ownerScope: "GUILD",
    guildClubId: spec.clubId === null ? undefined : (spec.clubId ?? BIG_ID),
    guildName: spec.name ?? "Fixture Guild",
    coverage: "All tabs currently reported viewable were serialized through QueryGuildBankTab; inaccessible tabs were not scanned.",
    snapshotVisit: spec.snapshotVisit ?? spec.observedAt - 5,
    tabs,
    containers,
    freeSlots: containers.reduce((n, c) => n + c.free, 0),
    totalSlots: containers.length * 98,
    itemsKnownEmpty: allObserved && viewable > 0 && items.length === 0,
    items,
  };
}

export interface WarbandSpec {
  observedAt: number;
  state?: CarrierState;
  completeness?: string;
  items?: Array<[string, number]>;
  purchasedTabs?: number;
  snapshotVisit?: number;
  status?: Partial<SectionStatus>;
}

export function warband(spec: WarbandSpec): AccountBankSection {
  const items = aggregate(spec.items ?? [["Linen Cloth", 5]]);
  return {
    status: { state: spec.state ?? "OBSERVED", completeness: spec.completeness ?? "complete", observedAt: spec.observedAt, ...spec.status },
    ownerScope: "ACCOUNT_WARBAND",
    coverage: "ACCOUNT/Warband purchased tabs only",
    snapshotVisit: spec.snapshotVisit ?? spec.observedAt - 1,
    purchasedBankTabs: spec.purchasedTabs ?? 1,
    containers: [{ id: 12, storage: "ACCOUNT_WARBAND", capacity: 98, free: 98 - items.length, family: "0", bagRef: "-" }],
    freeSlots: 98 - items.length,
    totalSlots: 98,
    itemsKnownEmpty: items.length === 0,
    items,
  };
}

export function carrier(snapshotId: number, exportObservedAt: number, name = "Virek", realm = "Cairne"): CarrierExport {
  return { snapshotId, sourceIdentityKey: `retail::${realm}::${name}`.toLowerCase(), sourceName: name, sourceRealm: realm, exportObservedAt };
}

/** Admits one section into a journal (the composition C2 will do inside the import transaction). */
export function admit(journal: SharedJournal, section: AccountBankSection | GuildBankSection, from: CarrierExport) {
  const admission = admitSection(section, from);
  assert.ok(admission.admitted, `expected admission, got ${JSON.stringify(admission)}`);
  return addToJournal(journal, admission.observation, admission.source);
}

export function admitAll(items: Array<[AccountBankSection | GuildBankSection, CarrierExport]>): SharedJournal {
  return items.reduce((journal, [section, from]) => admit(journal, section, from).journal, EMPTY_JOURNAL);
}
